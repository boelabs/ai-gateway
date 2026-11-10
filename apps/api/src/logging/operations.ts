import { deriveActiveKey, decryptJson, encryptJson } from "#db/crypto.ts";
import { EXECUTION_POLICY_MAX_TOTAL_MS } from "#core/executionPolicy.ts";
import { providerErrorDetail, internalMessage } from "./errorRecord.ts";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { PersistenceHealthTracker } from "./persistenceHealth.ts";
import { purgeExpiredAuditEntries } from "#db/repos/audit.ts";
import type { AdapterDiagnostics } from "#adapters/types.ts";
import { db, sql as postgresClient } from "#db/client.ts";
import type { OperationLogInput } from "./logger.ts";
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { redis } from "#cache/redis.ts";
import { env } from "#config/env.ts";
import { log } from "./log.ts";

import {
	finishOperationChildTelemetry,
	startOperationChildTelemetry,
	recordPersistenceQueueDelta,
	recordPersistenceLoss,
} from "#telemetry/index.ts";

import {
	payloadAccessAudit,
	gatewayOperations,
	upstreamAttempts,
	payloadSamples,
} from "#db/schema.ts";

const pending = new Set<Promise<void>>();
const persistenceHealth = new PersistenceHealthTracker();
const FINALIZATION_QUEUE_LIMIT = 10_000;
/**
 * Bytes the queued writes may hold. Each job keeps only the bounded, redacted forms of its payloads
 * (never the raw bodies), and counts their size here, so a burst of large requests is bounded by
 * memory rather than only by how many there are.
 */
const FINALIZATION_QUEUE_MAX_BYTES = 128 * 1024 * 1024;
/** What a write with no payload is charged, so even those cannot grow the queue without bound. */
const SMALL_JOB_BYTES = 512;
/**
 * Finalizations run in parallel up to half the pool, each a transaction holding a connection: more
 * than the pool would only queue inside it, and starve request-path queries while doing so.
 */
const FINALIZATION_BATCH_SIZE = Math.max(
	1,
	Math.floor(env.DATABASE_POOL_MAX / 2),
);
const finalizationQueue: Array<{
	run: () => Promise<void>;
	resolve: () => void;
	bytes: number;
	/** Writes of one request run in the order they were queued; different requests in parallel. */
	key: string;
}> = [];
let queuedBytes = 0;
let drainingFinalizations = false;
const SENSITIVE_KEY =
	/authorization|api[-_]?key|token|secret|password|cookie/iu;
const OPERATION_LEASE_TTL_SECONDS =
	Math.ceil(EXECUTION_POLICY_MAX_TOTAL_MS / 1000) + 300;
const operationLeaseKey = (operationId: string) =>
	`observability:operation-lease:${operationId}`;

async function drainFinalizations(): Promise<void> {
	if (drainingFinalizations) {
		return;
	}
	drainingFinalizations = true;
	try {
		while (finalizationQueue.length > 0) {
			const batch = finalizationQueue.splice(0, FINALIZATION_BATCH_SIZE);
			recordPersistenceQueueDelta(-batch.length);
			for (const job of batch) {
				queuedBytes -= job.bytes;
			}
			// One operation's writes stay in order (its row before its attempts, which reference it);
			// different operations' writes run concurrently.
			const byKey = new Map<string, typeof batch>();
			for (const job of batch) {
				byKey.set(job.key, [...(byKey.get(job.key) ?? []), job]);
			}
			await Promise.allSettled(
				[...byKey.values()].map(async (jobs) => {
					for (const job of jobs) {
						try {
							await job.run();
						} catch {
							// retry() already logged and counted it.
						} finally {
							job.resolve();
						}
					}
				}),
			);
		}
	} finally {
		drainingFinalizations = false;
		if (finalizationQueue.length > 0) {
			queueMicrotask(drainFinalizations);
		}
	}
}

function enqueueFinalization(
	run: () => Promise<void>,
	requestId: string,
	bytes = SMALL_JOB_BYTES,
): Promise<void> {
	if (
		finalizationQueue.length >= FINALIZATION_QUEUE_LIMIT ||
		queuedBytes + bytes > FINALIZATION_QUEUE_MAX_BYTES
	) {
		persistenceHealth.recordDrop();
		recordPersistenceLoss("dropped");
		log.error("operation-log", "finalization queue is full", {
			requestId,
			queueDepth: finalizationQueue.length,
			queuedBytes,
		});
		return Promise.resolve();
	}
	const task = new Promise<void>((resolve) => {
		finalizationQueue.push({ run, resolve, bytes, key: requestId });
		queuedBytes += bytes;
		recordPersistenceQueueDelta(1);
	});
	queueMicrotask(drainFinalizations);
	return task;
}

function track(task: Promise<void>): void {
	pending.add(task);
	void task.finally(() => pending.delete(task));
}

/**
 * A small write (operation start, attempt start, progress, model), through the same bounded queue
 * as finalizations so that no kind of operation write can pile up without limit.
 */
function enqueueWrite(
	requestId: string,
	write: () => Promise<void>,
): Promise<void> {
	return enqueueFinalization(() => retry(write, requestId), requestId);
}

async function retry(
	task: () => Promise<void>,
	requestId: string,
): Promise<void> {
	for (const delay of [0, 50, 250, 1000]) {
		if (delay > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
		try {
			await task();
			persistenceHealth.recordSuccess();
			return;
		} catch (err) {
			if (delay === 1000) {
				persistenceHealth.recordFailure();
				recordPersistenceLoss("failed");
				log.error("operation-log", "persistence failed after retries", {
					requestId,
					err,
				});
			}
		}
	}
}

function semanticByteCounts(value: unknown): {
	outputBytes: number;
	reasoningBytes: number;
} {
	let outputBytes = 0;
	let reasoningBytes = 0;
	const visit = (child: unknown, key: string, depth: number): void => {
		if (depth > 8) {
			return;
		}
		if (typeof child === "string") {
			const bytes = Buffer.byteLength(child);
			if (/reasoning|thinking/iu.test(key)) {
				reasoningBytes += bytes;
			} else if (/content|text|output|arguments|transcript/iu.test(key)) {
				outputBytes += bytes;
			}
			return;
		}
		if (Array.isArray(child)) {
			for (const item of child) {
				visit(item, key, depth + 1);
			}
			return;
		}
		if (child !== null && typeof child === "object") {
			for (const [name, nested] of Object.entries(
				child as Record<string, unknown>,
			)) {
				visit(nested, name, depth + 1);
			}
		}
	};
	visit(value, "", 0);
	return { outputBytes, reasoningBytes };
}

function safeSummary(
	value: unknown,
	json: string | null,
): Record<string, unknown> {
	if (json === null) {
		return { serializable: false };
	}
	const summary: Record<string, unknown> = {
		bytes: Buffer.byteLength(json),
		type: Array.isArray(value) ? "array" : typeof value,
		...semanticByteCounts(value),
	};
	if (Array.isArray(value)) {
		summary.items = value.length;
	}
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		summary.fields = Object.keys(value as Record<string, unknown>).sort();
		const counts: Record<string, number> = {};
		for (const field of ["messages", "input", "tools", "attachments", "data"]) {
			if (Array.isArray(record[field])) {
				counts[field] = record[field].length;
			}
		}
		if (Object.keys(counts).length > 0) {
			summary.counts = counts;
		}
		const parameters: Record<string, string | number | boolean | null> = {};
		for (const field of [
			"stream",
			"max_tokens",
			"max_completion_tokens",
			"max_output_tokens",
			"temperature",
			"top_p",
			"n",
			"dimensions",
			"size",
			"quality",
			"seconds",
			"response_format",
		]) {
			const child = record[field];
			if (
				child === null ||
				typeof child === "string" ||
				typeof child === "number" ||
				typeof child === "boolean"
			) {
				parameters[field] = child;
			}
		}
		if (Object.keys(parameters).length > 0) {
			summary.parameters = parameters;
		}
	}
	return summary;
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redact);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, child]) => [
			key,
			SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(child),
		]),
	);
}

function boundedPayloadComponent(value: unknown): unknown {
	let redacted: string;
	try {
		redacted = JSON.stringify(redact(value)) ?? "null";
	} catch {
		return { unavailable: "not_serializable" };
	}
	const limit = env.OBSERVABILITY_PAYLOAD_MAX_BYTES;
	if (Buffer.byteLength(redacted) <= limit) {
		return JSON.parse(redacted) as unknown;
	}
	let clipped = redacted;
	let serialized = JSON.stringify({ truncated: true, json: clipped });
	while (Buffer.byteLength(serialized) > limit && clipped.length > 0) {
		const ratio = Math.max(0.1, limit / Buffer.byteLength(serialized));
		clipped = clipped.slice(0, Math.floor(clipped.length * ratio) - 1);
		serialized = JSON.stringify({ truncated: true, json: clipped });
	}
	return JSON.parse(serialized) as unknown;
}

export function decryptPayload(
	envelope: Parameters<typeof decryptJson>[0],
): unknown {
	return decryptJson(envelope, "observability-payload");
}

function serialize(value: unknown): string | null {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return null;
	}
}

function fingerprintOf(serialized: string | null): string {
	const fingerprintKey = deriveActiveKey("observability-fingerprint");
	return createHmac("sha256", fingerprintKey)
		.update(serialized ?? "[not_serializable]")
		.digest("hex");
}

export function payloadFingerprint(value: unknown): string {
	return fingerprintOf(serialize(value));
}

/**
 * A payload reduced to what is persisted: its summary and fingerprint, from one serialization, and
 * its bounded, redacted form. Computed once per operation, so the raw body is not retained by the
 * queued write and a retry does not redo the work.
 */
function reducePayload(value: unknown): {
	summary: Record<string, unknown>;
	bounded: unknown;
} {
	const json = serialize(value);
	return {
		summary: { ...safeSummary(value, json), fingerprint: fingerprintOf(json) },
		bounded: boundedPayloadComponent(value),
	};
}

export interface OperationStart {
	id: string;
	requestId: string;
	virtualKeyId: string | null;
	/** "master-key", "root", "user:<uuid>", or "key:<uuid>". */
	actor: string;
	callType: string;
	publicModel: string | null;
	startedAt: Date;
}

export function newOperationId(): string {
	return randomUUID();
}

export function beginOperation(input: OperationStart): Promise<void> {
	const task = enqueueWrite(input.requestId, async () => {
		await db
			.insert(gatewayOperations)
			.values({
				id: input.id,
				requestId: input.requestId,
				virtualKeyId: input.virtualKeyId,
				actor: input.actor,
				callType: input.callType,
				publicModel: input.publicModel,
				startedAt: input.startedAt,
				lastProgressAt: input.startedAt,
			})
			.onConflictDoNothing();
		await redis.set(
			operationLeaseKey(input.id),
			input.requestId,
			"EX",
			OPERATION_LEASE_TTL_SECONDS,
		);
	});
	track(task);
	return task;
}

/**
 * Records that an attempt started, off the request path: the insert yields to the final upsert
 * (on conflict, nothing), so it may land late without overwriting the attempt's outcome.
 */
export function beginUpstreamAttempt(input: {
	operationId: string;
	ordinal: number;
	deploymentId: string;
	deploymentLabel: string | null;
	adapterKey: string;
	transport: string;
	upstreamModel: string;
	startedAt: Date;
	requestId: string;
}): void {
	const task = enqueueWrite(input.requestId, async () => {
		await db
			.insert(upstreamAttempts)
			.values({
				operationId: input.operationId,
				ordinal: input.ordinal,
				deploymentId: input.deploymentId,
				deploymentLabel: input.deploymentLabel,
				adapterKey: input.adapterKey,
				transport: input.transport,
				upstreamModel: input.upstreamModel,
				outcome: "in_progress",
				startedAt: input.startedAt,
				lastProgressAt: input.startedAt,
			})
			.onConflictDoNothing();
	});
	track(task);
}

interface OperationAttemptInput {
	deploymentId?: string;
	label?: string;
	adapterKey?: string;
	transport?: string;
	ms?: number;
	startedAt?: number;
	endedAt?: number;
	lastProgressAt?: number;
	ok?: boolean;
	errorClass?: string;
	errorCode?: string | null;
	errorMessage?: string;
	phase?: string;
	retryAfterMs?: number;
	failureKind?: string;
	httpStatus?: number;
	deploymentHealth?: "neutral";
	providerStatus?: number;
	providerBody?: unknown;
	terminalOutcome?: "completed" | "incomplete" | "blocked";
	terminalReason?: string;
	terminalVerified?: boolean;
	headersMs?: number;
	firstEventMs?: number;
	firstReasoningMs?: number;
	firstOutputMs?: number;
	maxInterEventGapMs?: number;
	downstreamBlockedMs?: number;
	upstreamBytes?: number;
	downstreamBytes?: number;
	transportTerminator?: string;
	frames?: number;
	metadataFrames?: number;
	reasoningFrames?: number;
	contentFrames?: number;
	toolFrames?: number;
	mediaFrames?: number;
	usageFrames?: number;
	usage?: OperationLogInput["usage"];
	estimatedCostCents?: number;
	diagnostics?: AdapterDiagnostics;
}

/**
 * Who ended the attempt.
 *
 * `provider` is reserved for a failure the upstream reported. A deadline is not one of those: the
 * upstream was still working and the gateway stopped waiting, on a budget the gateway chose - and
 * possibly narrowed on its own, well below what the operator configured. Reading those attempts as
 * the provider's failure sends an operator to a provider status page for a limit that lives in
 * their own router settings, which is exactly what `gateway_deadline` is here to prevent. It stays
 * distinct from `gateway`, which means the gateway itself malfunctioned.
 */
export function failureOwner(attempt: OperationAttemptInput): string | null {
	if (attempt.ok) {
		return null;
	}
	if (
		attempt.errorCode === "client_closed_request" ||
		attempt.errorCode === "downstream_backpressure"
	) {
		return "client";
	}
	// Ahead of the `neutral` branch below: a deadline the router narrowed is reported as neutral
	// precisely because the gateway set it, so the general answer would swallow the specific one
	// and the attempts hardest to diagnose would be the ones labelled least precisely.
	if (isGatewayDeadline(attempt)) {
		return "gateway_deadline";
	}
	// The upstream answered and rejected the request itself: invalid input, too long, blocked.
	if (
		attempt.failureKind === "request" &&
		attempt.providerStatus !== undefined
	) {
		return "client";
	}
	if (
		attempt.failureKind === "gateway" ||
		attempt.deploymentHealth === "neutral"
	) {
		return "gateway";
	}
	if (attempt.failureKind === "configuration") {
		return "deployment_config";
	}
	return "provider";
}

/**
 * A deadline the gateway imposed, as opposed to a timeout the upstream itself reported. Every one
 * of them is raised locally as `upstream_<phase>_timeout` with no provider status behind it; an
 * upstream that answers 408 or 504 keeps `providerStatus` and stays the provider's failure.
 */
function isGatewayDeadline(attempt: OperationAttemptInput): boolean {
	return (
		attempt.errorClass === "timeout" &&
		attempt.providerStatus === undefined &&
		(attempt.errorCode?.startsWith("upstream_") ?? false) &&
		(attempt.errorCode?.endsWith("_timeout") ?? false)
	);
}

/**
 * Where the attempt failed: `connect`, `response`, `stream` or `client` as the executor recorded
 * it, or `gateway` for a failure before any upstream exchange.
 */
function normalizedFailurePhase(attempt: OperationAttemptInput): string | null {
	if (attempt.ok) {
		return null;
	}
	if (
		attempt.errorCode === "client_closed_request" ||
		attempt.errorCode === "downstream_backpressure"
	) {
		return "client";
	}
	if (attempt.phase) {
		return attempt.phase;
	}
	if (attempt.failureKind === "gateway") {
		return "gateway";
	}
	return attempt.headersMs === undefined ? "connect" : "response";
}

/** The failure as the attempt row keeps it; see `errorRecord.ts` for what is and is not stored. */
function attemptErrorRecord(
	attempt: OperationAttemptInput,
	includeMessage: boolean,
): Record<string, unknown> {
	const provider = providerErrorDetail(attempt.providerBody, includeMessage);
	return {
		class: attempt.errorClass ?? null,
		code: attempt.errorCode ?? null,
		httpStatus: attempt.httpStatus ?? null,
		providerStatus: attempt.providerStatus ?? null,
		...(attempt.retryAfterMs === undefined
			? {}
			: { retryAfterMs: attempt.retryAfterMs }),
		...internalMessage(attempt.errorMessage, includeMessage),
		...(provider ? { provider } : {}),
	};
}

/** What went wrong, in one word an operator can filter and count by. */
function normalizedFailureKind(attempt: OperationAttemptInput): string | null {
	if (attempt.ok) {
		return null;
	}
	if (attempt.errorCode === "client_closed_request") {
		return "cancelled";
	}
	if (attempt.errorCode === "upstream_stream_truncated") {
		return "truncated";
	}
	if (attempt.errorCode?.includes("protocol")) {
		return "protocol";
	}
	switch (attempt.errorClass) {
		case "timeout":
		case "rate_limit":
		case "context_window":
		case "content_policy":
		case "auth":
		case "bad_request":
			return attempt.errorClass;
		case "permission":
		case "not_found":
			return "configuration";
		default:
			break;
	}
	if ((attempt.providerStatus ?? 0) >= 500) {
		return "upstream_server";
	}
	if (attempt.phase === "connect") {
		return "network";
	}
	return attempt.failureKind === "transient" ? "upstream_server" : "internal";
}

/**
 * How the request as a whole ended.
 *
 * A success without terminal evidence is an error: the gateway cannot claim an answer completed
 * when nothing said so. A client that hung up, or a downstream that stopped reading, is neither —
 * nobody failed, the request simply stopped being wanted.
 */
function operationOutcome(
	status: string,
	terminalVerified: boolean,
	terminalOutcome: string | undefined,
	// Whatever the error carried: this is log input, and its shape is not guaranteed.
	errorCode: unknown,
): "success" | "incomplete" | "blocked" | "cancelled" | "error" {
	if (status !== "success") {
		return errorCode === "client_closed_request" ||
			errorCode === "downstream_backpressure"
			? "cancelled"
			: "error";
	}
	if (!terminalVerified) {
		return "error";
	}
	if (terminalOutcome === "incomplete") {
		return "incomplete";
	}
	if (terminalOutcome === "blocked") {
		return "blocked";
	}
	return "success";
}

/** How an attempt ended, from the terminal evidence it carried. */
function attemptOutcome(
	attempt: OperationAttemptInput,
): "success" | "incomplete" | "blocked" | "error" {
	if (!attempt.ok) {
		return "error";
	}
	if (attempt.terminalOutcome === "incomplete") {
		return "incomplete";
	}
	if (attempt.terminalOutcome === "blocked") {
		return "blocked";
	}
	return "success";
}

/** What this attempt should do to the deployment's health score. */
function attemptHealthEffect(
	attempt: OperationAttemptInput,
): "reward" | "neutral" | "penalize" {
	if (attempt.terminalVerified === true) {
		return "reward";
	}
	return attempt.deploymentHealth === "neutral" ? "neutral" : "penalize";
}

/**
 * When output began arriving, or `null` when the response had no such moment.
 *
 * Gated on `streamed` rather than taken on trust: this column feeds the first-output percentile,
 * the stall filter and the dashboard, so one endpoint reporting a duration here is enough to make
 * all three mean something else - which is how the column came to hold two quantities at once. A
 * non-progressive response has no first output distinct from its last, and its total time is
 * already recorded as `durationMs`, so there is nothing to preserve by inventing one.
 */
export function firstOutputMsOf(
	streamed: boolean,
	lifecycleFirstOutputAt: number | null,
	input: Pick<OperationLogInput, "startTime" | "firstOutputMs">,
): number | null {
	if (!streamed) {
		return null;
	}
	if (lifecycleFirstOutputAt !== null) {
		return lifecycleFirstOutputAt - input.startTime.getTime();
	}
	return input.firstOutputMs;
}

export function completeOperation(
	operationId: string,
	started: Promise<void>,
	input: OperationLogInput,
): void {
	// Reducing the payloads (serializing, redacting, encrypting) is real work on bodies that can be
	// megabytes; it runs after the current turn, so the response is not held up by it.
	const prepared = new Promise<void>((resolve) => {
		setImmediate(() => {
			try {
				finalizeOperation(operationId, started, input);
			} catch (err) {
				log.error("operation-log", "failed to prepare an operation record", {
					requestId: input.requestId,
					err,
				});
			} finally {
				resolve();
			}
		});
	});
	track(prepared);
}

function finalizeOperation(
	operationId: string,
	started: Promise<void>,
	fullInput: OperationLogInput,
): void {
	const request = reducePayload(fullInput.requestBody);
	const response = reducePayload(fullInput.responseBody);
	const streamedBody =
		fullInput.responseBody !== null &&
		typeof fullInput.responseBody === "object" &&
		(fullInput.responseBody as { streamed?: unknown }).streamed === true;
	// From here on only the reduced forms are held; the raw bodies can be collected.
	const input: OperationLogInput = {
		...fullInput,
		requestBody: null,
		responseBody: null,
	};
	const lifecycle = input.metadata.streamLifecycle as
		| {
				firstEventAt?: number | null;
				firstReasoningAt?: number | null;
				firstOutputAt?: number | null;
				maxInterEventGapMs?: number;
				terminal?: { outcome?: string } | null;
		  }
		| undefined;
	const streamed = lifecycle !== undefined || streamedBody;
	const terminal =
		lifecycle?.terminal ??
		(input.metadata.terminal as { outcome?: string } | undefined) ??
		null;
	const downstream = input.metadata.downstream as
		| { maxBlockedMs?: number }
		| undefined;
	const terminalVerified = input.status === "success" && terminal != null;
	const outcome = operationOutcome(
		input.status,
		terminalVerified,
		terminal?.outcome,
		input.error?.code,
	);
	const degraded =
		input.retries > 0 ||
		input.fallbackUsed ||
		!terminalVerified ||
		outcome === "incomplete" ||
		outcome === "blocked";
	const attempts = (input.attempts ?? []) as OperationAttemptInput[];
	const knownUpstreamCost = attempts.reduce(
		(total, attempt) =>
			total +
			(attempt.usage?.providerCostCents ?? attempt.estimatedCostCents ?? 0),
		0,
	);
	const upstreamBytes = attempts.reduce(
		(total, attempt) => total + (attempt.upstreamBytes ?? 0),
		0,
	);
	const downstreamBytes = attempts.reduce(
		(total, attempt) => total + (attempt.downstreamBytes ?? 0),
		0,
	);
	const requestSummary = request.summary;
	const responseSummary = response.summary;
	// Every finished operation keeps a sample. Sampling the successful ones was a storage decision
	// that cost the operator the one case they always need: the request that "worked" and still
	// returned the wrong thing. What limits the exposure is retention, redaction and
	// OBSERVABILITY_PAYLOAD_ACCESS - not luck.
	const envelope = encryptJson(
		{
			request: request.bounded,
			response: response.bounded,
			error: boundedPayloadComponent(input.error),
			attempts: boundedPayloadComponent(input.attempts),
		},
		"observability-payload",
	);
	const jobBytes =
		Buffer.byteLength(JSON.stringify(envelope)) + SMALL_JOB_BYTES;
	/** What the summary measured, for responses no attempt reported a byte count for. */
	const summaryBytes =
		typeof responseSummary.bytes === "number" ? responseSummary.bytes : null;
	/**
	 * A request that finished without an upstream error but also without terminal evidence is
	 * recorded as a gateway failure rather than as a clean success nobody can vouch for.
	 */
	const missingTerminalError = terminalVerified
		? null
		: {
				class: "server",
				code: "missing_terminal_evidence",
				failure_kind: "gateway",
			};
	const persistenceTelemetry = startOperationChildTelemetry(
		operationId,
		"persistence",
	);
	const task = enqueueFinalization(
		() =>
			started.then(() =>
				retry(async () => {
					// A finished parent must never be observable with stale in-progress attempts.
					await db.transaction(async (tx) => {
						// An upsert, not an update: the row opened at the start may never have been
						// written (its write was dropped or failed), and the finished record must not
						// be lost with it.
						const finished: Partial<typeof gatewayOperations.$inferInsert> = {
							publicModel: input.publicModel,
							lifecycleState: "finished",
							outcome,
							degraded,
							terminalVerified,
							cacheHit: input.cacheHit,
							stream: streamed,
							httpStatus: input.httpStatus,
							promptTokens: input.usage?.promptTokens ?? null,
							completionTokens: input.usage?.completionTokens ?? null,
							reasoningTokens: input.usage?.reasoningTokens ?? null,
							cacheReadTokens: input.usage?.cacheReadTokens ?? null,
							cacheWriteTokens: input.usage?.cacheWriteTokens ?? null,
							totalTokens: input.usage?.totalTokens ?? null,
							searchUnits: input.usage?.searchUnits ?? null,
							consumerCostCents: input.cost?.totalCents.toFixed(10) ?? null,
							upstreamCostCents:
								(attempts.length > 0
									? knownUpstreamCost
									: input.cost?.totalCents
								)?.toFixed(10) ?? null,
							durationMs: input.durationMs,
							firstOutputMs: firstOutputMsOf(
								streamed,
								lifecycle?.firstOutputAt ?? null,
								input,
							),
							firstEventMs:
								lifecycle?.firstEventAt == null
									? null
									: lifecycle.firstEventAt - input.startTime.getTime(),
							firstReasoningMs:
								lifecycle?.firstReasoningAt == null
									? null
									: lifecycle.firstReasoningAt - input.startTime.getTime(),
							maxInterEventGapMs: lifecycle?.maxInterEventGapMs ?? null,
							downstreamBlockedMs:
								downstream?.maxBlockedMs ??
								(attempts.length > 0
									? Math.max(
											...attempts.map(
												(attempt) => attempt.downstreamBlockedMs ?? 0,
											),
										)
									: null),
							upstreamBytes: attempts.length > 0 ? upstreamBytes : null,
							downstreamBytes:
								downstreamBytes > 0 ? downstreamBytes : summaryBytes,
							endedAt: input.endTime,
							lastProgressAt: input.endTime,
							reasoning: input.metadata.reasoning ?? null,
							requestSummary,
							responseSummary,
							metadata: {
								...input.metadata,
								...(input.usage?.cacheWriteTokensByTtl === undefined
									? {}
									: {
											cacheWriteTokensByTtl: input.usage.cacheWriteTokensByTtl,
										}),
								// The upstream reported no usage: the counts above are the gateway's estimate.
								...(input.usage?.estimated ? { usageEstimated: true } : {}),
								...(input.usage?.serviceTier === undefined
									? {}
									: { serviceTier: input.usage.serviceTier }),
								client: {
									ipFingerprint: payloadFingerprint(input.ip),
									userAgentFingerprint: payloadFingerprint(input.userAgent),
								},
							},
							error: input.error
								? {
										class: input.error.class,
										code: input.error.code,
										http_status: input.error.http_status,
										failure_kind: input.error.failure_kind,
										...(input.error.phase === undefined
											? {}
											: { phase: input.error.phase }),
										...internalMessage(
											typeof input.error.message === "string"
												? input.error.message
												: undefined,
											payloadAccessIsOpen(),
										),
									}
								: missingTerminalError,
						};
						await tx
							.insert(gatewayOperations)
							.values({
								id: operationId,
								requestId: input.requestId,
								virtualKeyId: input.virtualKeyId,
								actor: input.actor ?? null,
								callType: input.callType,
								startedAt: input.startTime,
								...finished,
							})
							.onConflictDoUpdate({
								target: gatewayOperations.id,
								set: finished,
							});

						if (attempts.length > 0) {
							await tx
								.insert(upstreamAttempts)
								.values(
									attempts.map((attempt, index) => {
										const endedAt = new Date(
											attempt.endedAt ?? input.endTime.getTime(),
										);
										const durationMs = Math.max(0, attempt.ms ?? 0);
										return {
											operationId,
											ordinal: index + 1,
											deploymentId: attempt.deploymentId ?? null,
											deploymentLabel: attempt.label ?? null,
											adapterKey: attempt.adapterKey ?? null,
											transport: attempt.transport ?? null,
											outcome: attemptOutcome(attempt),
											terminalVerified: attempt.terminalVerified === true,
											transportTerminator: attempt.transportTerminator ?? null,
											failureOwner: failureOwner(attempt),
											failureKind: normalizedFailureKind(attempt),
											failurePhase: normalizedFailurePhase(attempt),
											healthEffect: attemptHealthEffect(attempt),
											httpStatus: attempt.httpStatus ?? null,
											providerStatus: attempt.providerStatus ?? null,
											durationMs,
											headersMs: attempt.headersMs ?? null,
											firstEventMs: attempt.firstEventMs ?? null,
											firstReasoningMs: attempt.firstReasoningMs ?? null,
											firstOutputMs: attempt.firstOutputMs ?? null,
											maxInterEventGapMs: attempt.maxInterEventGapMs ?? null,
											downstreamBlockedMs: attempt.downstreamBlockedMs ?? null,
											upstreamBytes: attempt.upstreamBytes ?? null,
											downstreamBytes: attempt.downstreamBytes ?? null,
											frames: attempt.frames ?? null,
											metadataFrames: attempt.metadataFrames ?? null,
											reasoningFrames: attempt.reasoningFrames ?? null,
											contentFrames: attempt.contentFrames ?? null,
											toolFrames: attempt.toolFrames ?? null,
											mediaFrames: attempt.mediaFrames ?? null,
											usageFrames: attempt.usageFrames ?? null,
											promptTokens: attempt.usage?.promptTokens ?? null,
											completionTokens: attempt.usage?.completionTokens ?? null,
											reasoningTokens: attempt.usage?.reasoningTokens ?? null,
											cacheReadTokens: attempt.usage?.cacheReadTokens ?? null,
											cacheWriteTokens: attempt.usage?.cacheWriteTokens ?? null,
											totalTokens: attempt.usage?.totalTokens ?? null,
											searchUnits: attempt.usage?.searchUnits ?? null,
											lastProgressAt: new Date(
												attempt.lastProgressAt ?? endedAt.getTime(),
											),
											startedAt: new Date(
												attempt.startedAt ?? endedAt.getTime() - durationMs,
											),
											endedAt,
											diagnostics: {
												...(attempt.diagnostics ?? {}),
												estimatedCostCents: attempt.estimatedCostCents ?? null,
												terminalOutcome: attempt.terminalOutcome ?? null,
												terminalReason: attempt.terminalReason ?? null,
											},
											error: attempt.ok
												? null
												: attemptErrorRecord(attempt, payloadAccessIsOpen()),
										};
									}),
								)
								.onConflictDoUpdate({
									target: [
										upstreamAttempts.operationId,
										upstreamAttempts.ordinal,
									],
									set: {
										outcome: sql`excluded.outcome`,
										terminalVerified: sql`excluded.terminal_verified`,
										transportTerminator: sql`excluded.transport_terminator`,
										failureOwner: sql`excluded.failure_owner`,
										failureKind: sql`excluded.failure_kind`,
										failurePhase: sql`excluded.failure_phase`,
										healthEffect: sql`excluded.health_effect`,
										httpStatus: sql`excluded.http_status`,
										providerStatus: sql`excluded.provider_status`,
										durationMs: sql`excluded.duration_ms`,
										headersMs: sql`excluded.headers_ms`,
										firstEventMs: sql`excluded.first_event_ms`,
										firstReasoningMs: sql`excluded.first_reasoning_ms`,
										firstOutputMs: sql`excluded.first_output_ms`,
										maxInterEventGapMs: sql`excluded.max_inter_event_gap_ms`,
										downstreamBlockedMs: sql`excluded.downstream_blocked_ms`,
										upstreamBytes: sql`excluded.upstream_bytes`,
										downstreamBytes: sql`excluded.downstream_bytes`,
										frames: sql`excluded.frames`,
										metadataFrames: sql`excluded.metadata_frames`,
										reasoningFrames: sql`excluded.reasoning_frames`,
										contentFrames: sql`excluded.content_frames`,
										toolFrames: sql`excluded.tool_frames`,
										mediaFrames: sql`excluded.media_frames`,
										usageFrames: sql`excluded.usage_frames`,
										promptTokens: sql`excluded.prompt_tokens`,
										completionTokens: sql`excluded.completion_tokens`,
										reasoningTokens: sql`excluded.reasoning_tokens`,
										cacheReadTokens: sql`excluded.cache_read_tokens`,
										cacheWriteTokens: sql`excluded.cache_write_tokens`,
										totalTokens: sql`excluded.total_tokens`,
										searchUnits: sql`excluded.search_units`,
										lastProgressAt: sql`excluded.last_progress_at`,
										startedAt: sql`excluded.started_at`,
										endedAt: sql`excluded.ended_at`,
										// The row opened before the upstream call has neither; without these the
										// provider's answer and the attempt's diagnostics were silently dropped.
										diagnostics: sql`excluded.diagnostics`,
										error: sql`excluded.error`,
									},
								});
						}

						// An attempt row is opened before the upstream is contacted, but the attempt log
						// that closes it belongs to whoever reports the result. A coordinator that
						// re-enters the router can finish the operation carrying only the last route's
						// log, and the rows opened earlier would stay "in_progress" forever - the
						// expiry sweeper never reaches them, because the operation itself did finish.
						await tx
							.update(upstreamAttempts)
							.set({ outcome: "abandoned", endedAt: input.endTime })
							.where(
								and(
									eq(upstreamAttempts.operationId, operationId),
									eq(upstreamAttempts.outcome, "in_progress"),
								),
							);
					});

					await db
						.insert(payloadSamples)
						.values({
							operationId,
							captureReason: degraded ? "degraded" : outcome,
							envelope,
							expiresAt: new Date(
								Date.now() +
									env.OBSERVABILITY_PAYLOAD_RETENTION_DAYS * 86_400_000,
							),
						})
						.onConflictDoNothing();
					await redis.del(operationLeaseKey(operationId));
				}, input.requestId),
			),
		input.requestId,
		jobBytes,
	);
	void task.finally(() => finishOperationChildTelemetry(persistenceTelemetry));
	track(task);
}

export function touchOperation(operationId: string, requestId: string): void {
	const now = new Date();
	const task = enqueueWrite(requestId, async () => {
		await Promise.all([
			db
				.update(gatewayOperations)
				.set({ lastProgressAt: now })
				.where(eq(gatewayOperations.id, operationId)),
			db
				.update(upstreamAttempts)
				.set({ lastProgressAt: now })
				.where(
					and(
						eq(upstreamAttempts.operationId, operationId),
						eq(upstreamAttempts.outcome, "in_progress"),
					),
				),
			redis.expire(operationLeaseKey(operationId), OPERATION_LEASE_TTL_SECONDS),
		]);
	});
	track(task);
}

export function identifyOperation(
	operationId: string,
	started: Promise<void>,
	requestId: string,
	publicModel: string | null,
): void {
	const task = enqueueWrite(requestId, async () => {
		await started;
		await db
			.update(gatewayOperations)
			.set({ publicModel })
			.where(eq(gatewayOperations.id, operationId));
	});
	track(task);
}

export async function flushOperationLogs(): Promise<void> {
	// A record prepared after the response (see completeOperation) enqueues its write only once its
	// preparation runs, so one pass is not enough: drain until nothing is pending or queued.
	while (pending.size > 0 || finalizationQueue.length > 0) {
		await drainFinalizations();
		await Promise.allSettled([...pending]);
	}
}

export function operationPersistenceStatus() {
	return persistenceHealth.status({
		pending: pending.size,
		queueDepth: finalizationQueue.length,
		queueCapacity: FINALIZATION_QUEUE_LIMIT,
		encryptedSampling: true,
	});
}

export async function reconcileAbandonedOperations(
	before = new Date(Date.now() - 15 * 60_000),
): Promise<number> {
	const stale = await db
		.select({ id: gatewayOperations.id })
		.from(gatewayOperations)
		.where(
			and(
				eq(gatewayOperations.lifecycleState, "in_progress"),
				isNull(gatewayOperations.outcome),
				lt(gatewayOperations.lastProgressAt, before),
			),
		)
		.limit(1000);
	if (stale.length === 0) {
		return 0;
	}
	const leases = await redis.mget(
		...stale.map((row) => operationLeaseKey(row.id)),
	);
	const expiredIds = stale
		.filter((_row, index) => leases[index] === null)
		.map((row) => row.id);
	if (expiredIds.length === 0) {
		return 0;
	}
	const rows = await db
		.update(gatewayOperations)
		.set({
			lifecycleState: "finished",
			outcome: "abandoned",
			terminalVerified: false,
			endedAt: new Date(),
		})
		.where(
			and(
				eq(gatewayOperations.lifecycleState, "in_progress"),
				isNull(gatewayOperations.outcome),
				inArray(gatewayOperations.id, expiredIds),
			),
		)
		.returning({ id: gatewayOperations.id });
	if (rows.length > 0) {
		await db
			.update(upstreamAttempts)
			.set({ outcome: "abandoned", endedAt: new Date() })
			.where(
				and(
					inArray(
						upstreamAttempts.operationId,
						rows.map((row) => row.id),
					),
					eq(upstreamAttempts.outcome, "in_progress"),
				),
			);
	}
	return rows.length;
}

/**
 * What a read of a retained sample produced. Every branch is audited, including the ones that
 * return nothing: "who tried" is as much a part of the trail as "who saw".
 */
export type PayloadReadOutcome =
	| "revealed"
	/** No sample: the operation predates capture, or retention already swept it. */
	| "missing"
	/** OBSERVABILITY_PAYLOAD_ACCESS=sealed. The envelope was never touched. */
	| "sealed"
	/** The sample outlived the key that sealed it. */
	| "unreadable";

export type PayloadSampleRead =
	| { outcome: "revealed"; payload: unknown }
	| { outcome: Exclude<PayloadReadOutcome, "revealed"> };

/** Whether this deployment lets anyone read retained samples at all. */
export function payloadAccessIsOpen(): boolean {
	return env.OBSERVABILITY_PAYLOAD_ACCESS === "open";
}

/**
 * Decrypts one retained sample, or explains why it cannot.
 *
 * Refusal comes first and costs nothing: a sealed gateway answers without reading the row, so the
 * plaintext never exists in this process, and the attempt is still recorded.
 */
export async function getPayloadSample(
	operationId: string,
	audit: { requestId: string; actor: string },
): Promise<PayloadSampleRead> {
	const record = async (outcome: PayloadReadOutcome) => {
		await db.insert(payloadAccessAudit).values({
			operationId,
			requestId: audit.requestId,
			actor: audit.actor,
			outcome,
		});
		log.warn("audit", "observability payload queried", {
			operationId,
			requestId: audit.requestId,
			actor: audit.actor,
			outcome,
		});
	};
	if (!payloadAccessIsOpen()) {
		await record("sealed");
		return { outcome: "sealed" };
	}
	const [row] = await db
		.select()
		.from(payloadSamples)
		.where(eq(payloadSamples.operationId, operationId))
		.limit(1);
	if (row === undefined || row.expiresAt <= new Date()) {
		await record("missing");
		return { outcome: "missing" };
	}
	let payload: unknown;
	try {
		payload = decryptPayload(row.envelope);
	} catch {
		await record("unreadable");
		return { outcome: "unreadable" };
	}
	await record("revealed");
	await db
		.update(payloadSamples)
		.set({ accessedAt: new Date() })
		.where(eq(payloadSamples.id, row.id));
	return { outcome: "revealed", payload };
}

/** Rows deleted per statement, and the most statements one maintenance pass may run per table. */
const PURGE_BATCH = 1000;
const MAX_PURGE_BATCHES = 50;
const MAINTENANCE_INTERVAL_MS = 60_000;
/** Shared by every replica, so only one runs maintenance at a time. Never change it. */
const MAINTENANCE_LOCK_ID = 918_273_646;

/** Expired operations, oldest first, along with their attempts and samples. Returns rows removed. */
async function purgeExpiredOperations(cutoff: Date): Promise<number> {
	let purged = 0;
	for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
		// Served by the partial index on (ended_at) WHERE lifecycle_state = 'finished'.
		const expired = await db
			.select({ id: gatewayOperations.id })
			.from(gatewayOperations)
			.where(
				and(
					eq(gatewayOperations.lifecycleState, "finished"),
					lt(gatewayOperations.endedAt, cutoff),
				),
			)
			.orderBy(asc(gatewayOperations.endedAt))
			.limit(PURGE_BATCH);
		if (expired.length === 0) {
			break;
		}
		const ids = expired.map((row) => row.id);
		await db.transaction(async (tx) => {
			await tx
				.delete(payloadSamples)
				.where(inArray(payloadSamples.operationId, ids));
			await tx
				.delete(upstreamAttempts)
				.where(inArray(upstreamAttempts.operationId, ids));
			await tx
				.delete(gatewayOperations)
				.where(inArray(gatewayOperations.id, ids));
		});
		purged += ids.length;
		if (expired.length < PURGE_BATCH) {
			break;
		}
	}
	return purged;
}

/** Samples past their own expiry, in batches. */
async function purgeExpiredSamples(now: Date): Promise<number> {
	let purged = 0;
	for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
		const rows = await db.execute(sql`
			DELETE FROM ${payloadSamples}
			WHERE ${payloadSamples.id} IN (
				SELECT ${payloadSamples.id} FROM ${payloadSamples}
				WHERE ${payloadSamples.expiresAt} <= ${now.toISOString()}::timestamptz
				LIMIT ${PURGE_BATCH}
			)
			RETURNING ${payloadSamples.id}`);
		purged += rows.length;
		if (rows.length < PURGE_BATCH) {
			break;
		}
	}
	return purged;
}

/**
 * One maintenance pass. Each step runs on its own, so a failing one (a lock timeout on the audit
 * table, say) does not skip the retention work after it.
 */
export async function runOperationMaintenance(now = new Date()): Promise<void> {
	const retentionCutoff = new Date(
		now.getTime() - env.OBSERVABILITY_METADATA_RETENTION_DAYS * 86_400_000,
	);
	const steps: [string, () => Promise<void>][] = [
		[
			"reconcile abandoned operations",
			async () => {
				const abandoned = await reconcileAbandonedOperations();
				if (abandoned > 0) {
					log.error("operation-log", "reconciled abandoned operations", {
						abandoned,
					});
				}
			},
		],
		[
			"purge expired samples",
			() => purgeExpiredSamples(now).then(() => undefined),
		],
		[
			"purge payload access audit",
			async () => {
				await db
					.delete(payloadAccessAudit)
					.where(lt(payloadAccessAudit.accessedAt, retentionCutoff));
			},
		],
		[
			"purge admin audit",
			async () => {
				const audited = await purgeExpiredAuditEntries(
					new Date(now.getTime() - env.ADMIN_AUDIT_RETENTION_DAYS * 86_400_000),
				);
				if (audited > 0) {
					log.info("operation-log", "purged expired audit entries", {
						audited,
					});
				}
			},
		],
		[
			"purge expired operations",
			async () => {
				const purged = await purgeExpiredOperations(retentionCutoff);
				if (purged > 0) {
					log.info("operation-log", "purged expired operations", { purged });
				}
			},
		],
	];
	for (const [name, step] of steps) {
		try {
			await step();
		} catch (err) {
			log.error("operation-log", `maintenance step failed: ${name}`, { err });
		}
	}
}

/**
 * Runs maintenance every minute on whichever replica holds the maintenance lock (others skip the
 * pass), and schedules the next pass only once the current one has finished, so passes never
 * overlap however long one takes.
 */
export function startOperationMaintenance(): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pass = async () => {
		try {
			await postgresClient.lock(
				MAINTENANCE_LOCK_ID,
				() => runOperationMaintenance(),
				{
					wait: false,
				},
			);
		} catch (err) {
			if ((err as { code?: string }).code !== "LOCK_NOT_AVAILABLE") {
				log.error("operation-log", "maintenance failed", { err });
			}
		} finally {
			if (!stopped) {
				timer = setTimeout(() => void pass(), MAINTENANCE_INTERVAL_MS);
				timer.unref();
			}
		}
	};
	void pass();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}
