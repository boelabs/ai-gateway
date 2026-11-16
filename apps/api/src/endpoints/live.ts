import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { completedTerminal } from "#gateway/streamLifecycle.ts";
import { liveSessionRecord, rememberLiveSession } from "#live/sessions.ts";
import type { LiveSessionRecord } from "#live/sessions.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import { route, type RouteResult } from "#router/index.ts";
import { getDeploymentById } from "#db/repos/deployments.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { resolveTransport } from "#router/transport.ts";
import { upgradeWebSocket } from "#http/bunServer.ts";
import { getAdapter } from "#adapters/registry.ts";
import { liveProfileFor } from "#catalog/types.ts";
import { computeCost } from "#logging/cost.ts";
import { GatewayError } from "#core/errors.ts";
import { decryptRecord } from "#db/crypto.ts";
import { getAuth } from "#auth/middleware.ts";
import type { RawSocket } from "#http/bunServer.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";
import { log as logger } from "#logging/log.ts";
import type { WSContext, WSEvents } from "hono/ws";
import type { Context } from "hono";

import type {
	LiveServerFrame,
	AdapterContext,
	LiveUpstream,
} from "#adapters/types.ts";

import {
	type LiveTransport,
	liveDelegatedModels,
	liveDelegationType,
	LiveUsageMeter,
} from "#core/live.ts";

import {
	assertRealtimeSocketCapacity,
	type RealtimeSocketEntry,
	unregisterRealtimeSocket,
	assertWebSocketUpgrade,
	registerRealtimeSocket,
	revalidateConnection,
	MAX_MESSAGE_BYTES,
	capacityLimitError,
	MAX_QUEUED_EVENTS,
	admitQueuedBytes,
	queuedBytesError,
	messageBytes,
	watchCredential,
} from "./realtimeSockets.ts";

import {
	PUBLIC_JSON_BODY_MAX_BYTES,
	assertFinalModelAllowed,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	readJsonBody,
	preflight,
} from "./runtime/pipeline.ts";

import { MAX_BUFFERED_SEND_BYTES } from "./socketServer.ts";

/**
 * OpenAI's GPT-Live API, relayed: `/v1/live/sessions` (WebSocket session, or `POST` for WebRTC and
 * SIP), `/{id}/attach` (sideband), `/{id}/fork` and `/{id}/content`.
 *
 * Frames pass through as the provider sent them. The gateway routes `session.model` (public) to a
 * deployment, shows the client its public name back in `session.*` events, refuses delegation to a
 * model it cannot bill, and meters each session as one `live.session` operation: the session
 * seconds the provider reports, plus every backend response and decision priced against its model.
 */

/** A live session gets the realtime sessions' ceiling (the execution policy's longest total). */
const LIVE_MAX_MS = 60 * 60 * 1000;
/** How long a closing client waits for the provider's final usage (`session.closed`). */
const CLOSE_GRACE_MS = 5000;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function badRequest(
	message: string,
	param: string | null,
	code = "invalid_request",
): GatewayError {
	return new GatewayError({
		class: "bad_request",
		code,
		message,
		publicMessage: message,
		...(param ? { param } : {}),
	});
}

/** A GatewayError as a GPT-Live `error` server event. */
function liveErrorEvent(
	error: GatewayError,
	clientEventId: string | null,
): Record<string, unknown> {
	const body = error.toOpenAI().error;
	return {
		type: "error",
		event_id: `event_${randomUUID().replaceAll("-", "")}`,
		...(clientEventId ? { client_event_id: clientEventId } : {}),
		error: {
			type: body.type,
			code: body.code ?? null,
			message: body.message,
			param: body.param ?? null,
			...(clientEventId ? { client_event_id: clientEventId } : {}),
		},
	};
}

/** A server frame for the client: `session.*` events name the public model, not the upstream one. */
export function clientFrame(
	frame: LiveServerFrame,
	publicModel: string,
): string {
	const session = record(frame.event.session);
	if (typeof session?.model !== "string" || session.model === publicModel) {
		return frame.text;
	}
	return JSON.stringify({
		...frame.event,
		session: { ...session, model: publicModel },
	});
}

/** The client's body with `session.model` set to the deployment's upstream model, when it names one. */
function withUpstreamModel(
	body: Record<string, unknown>,
	upstreamModel: string,
): Record<string, unknown> {
	const session = record(body.session) ?? {};
	return typeof session.model === "string"
		? { ...body, session: { ...session, model: upstreamModel } }
		: body;
}

/**
 * Refuses, for one candidate, a session it cannot serve or the gateway cannot bill: a delegation
 * type or transport the model lacks, or delegation to a model the key may not use or the catalog
 * does not price (its usage would go unbilled).
 */
function assertLiveSessionSupported(
	c: Context<AppEnv>,
	session: Record<string, unknown>,
	candidate: DeploymentCandidate,
	transport: LiveTransport,
): void {
	const profile = liveProfileFor(candidate.meta);
	if (!profile) {
		throw badRequest(
			`Model ${candidate.row.publicModel} does not serve live sessions.`,
			"session.model",
			"unsupported_model",
		);
	}
	if (profile.transports && !profile.transports.includes(transport)) {
		throw badRequest(
			`This model does not support ${transport} live sessions.`,
			"transport",
			"unsupported_value",
		);
	}
	const delegation = liveDelegationType(session);
	if (
		profile.delegationTypes &&
		!(profile.delegationTypes as string[]).includes(delegation)
	) {
		throw badRequest(
			`This model does not support ${delegation} delegation.`,
			"session.delegation.type",
			"unsupported_value",
		);
	}
	assertDelegatedModelsBillable(c, session, candidate.adapter.key);
}

function assertDelegatedModelsBillable(
	c: Context<AppEnv>,
	session: Record<string, unknown>,
	adapterKey: string,
): void {
	for (const model of liveDelegatedModels(session)) {
		assertFinalModelAllowed(c, model);
		if (!resolveModelMetadata(adapterKey, model).pricing) {
			throw badRequest(
				`The gateway has no price for delegation model ${model}, so it cannot bill its usage.`,
				"session.delegation",
				"unsupported_model",
			);
		}
	}
}

/* ------------------------------------------------------------------ metering */

/** One metered live session: its route, its log and its usage so far. */
class LiveRun {
	readonly meter: LiveUsageMeter;
	readonly routing: RouteResult<unknown>;
	readonly log: OperationLogDraft;
	private readonly transport: LiveTransport;
	private ended = false;
	private readonly startedAt = Date.now();

	constructor(
		routing: RouteResult<unknown>,
		log: OperationLogDraft,
		session: Record<string, unknown>,
		transport: LiveTransport,
	) {
		this.routing = routing;
		this.log = log;
		this.transport = transport;
		const responses = record(record(session.delegation)?.responses);
		this.meter = new LiveUsageMeter(
			typeof responses?.model === "string" ? responses.model : undefined,
		);
	}

	/**
	 * Billable usage: the reported session seconds and the delegated work's cost. A session that
	 * ended without the provider's final figure is billed by the clock, flagged as an estimate.
	 */
	usage(final: boolean): Usage {
		const adapterKey = this.routing.candidate.adapter.key;
		const delegated = this.meter.delegated.reduce(
			(total, item) =>
				total +
				computeCost(resolveModelMetadata(adapterKey, item.model), item.usage)
					.totalCents,
			0,
		);
		const clock = (Date.now() - this.startedAt) / 1000;
		const estimated = final && !this.meter.closed && clock > this.meter.seconds;
		const seconds = estimated ? clock : this.meter.seconds;
		return {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			inputAudioSeconds: Math.round(seconds * 1000) / 1000,
			...(delegated > 0 ? { delegatedCostCents: delegated } : {}),
			...(estimated ? { estimated: true } : {}),
		};
	}

	/** Reads a server event; true when the key's budget is now spent. */
	async observe(event: Record<string, unknown>): Promise<boolean> {
		this.log.progress();
		if (event.type === "session.updated") {
			const responses = record(
				record(record(event.session)?.delegation)?.responses,
			);
			this.meter.delegateTo(
				typeof responses?.model === "string" ? responses.model : undefined,
			);
		}
		if (!this.meter.observe(event)) {
			return false;
		}
		const { budgetExhausted } = await this.routing.charge(this.usage(false));
		return budgetExhausted;
	}

	async end(
		error: GatewayError | null,
		sessionId: string | null,
	): Promise<void> {
		if (this.ended) {
			return;
		}
		this.ended = true;
		const usage = this.usage(true);
		const terminal = error ? null : completedTerminal(usage);
		await this.routing.finish(usage, undefined, error, terminal);
		this.log.write({
			status: error ? "error" : "success",
			httpStatus: error?.httpStatus ?? 200,
			usage,
			cost: computeUsageCost(this.routing.candidate.meta, usage),
			firstOutputMs: null,
			responseBody: {
				streamed: true,
				sessionId,
				transport: this.transport,
				seconds: usage.inputAudioSeconds ?? 0,
				delegated: this.meter.delegated.map((item) => ({
					model: item.model,
					promptTokens: item.usage.promptTokens,
					completionTokens: item.usage.completionTokens,
				})),
			},
			metadata: {
				...candidateMetadata(this.routing.candidate),
				...(terminal ? { terminal } : {}),
				...(usage.estimated ? { usageEstimated: true } : {}),
			},
			error: error ? error.toLog() : null,
		});
	}
}

function budgetExceededError(): GatewayError {
	return new GatewayError({
		class: "rate_limit",
		code: "budget_exceeded",
		message: "Budget exhausted for this API key during the live session",
		failureKind: "request",
		deploymentHealth: "neutral",
	});
}

/** The deployment a known session lives on, refused to any key but the one that opened it. */
async function ownedSession(
	c: Context<AppEnv>,
	sessionId: string,
): Promise<LiveSessionRecord> {
	const auth = getAuth(c);
	const scopeKey = auth.type === "virtual" ? auth.key.id : "master";
	const found = await liveSessionRecord(sessionId);
	if (!found || (scopeKey !== "master" && found.scopeKey !== scopeKey)) {
		throw new GatewayError({
			class: "not_found",
			code: "session_not_found",
			message: `Live session ${sessionId} not found`,
			publicMessage: `Live session '${sessionId}' not found.`,
		});
	}
	return found;
}

/** An adapter context for the deployment a session lives on, outside routing (attach, content). */
async function sessionContext(
	found: LiveSessionRecord,
	signal: AbortSignal,
): Promise<{
	ctx: AdapterContext;
	handler: NonNullable<ReturnType<typeof getAdapter>>["liveSession"];
}> {
	const deployment = await getDeploymentById(found.deploymentId);
	const adapter = deployment ? getAdapter(deployment.adapterKey) : undefined;
	if (!(deployment && adapter?.liveSession)) {
		throw new GatewayError({
			class: "not_found",
			code: "session_not_found",
			message: `The deployment of live session ${found.deploymentId} is gone`,
			publicMessage: "Live session not found.",
		});
	}
	const meta = resolveModelMetadata(
		deployment.adapterKey,
		deployment.upstreamModel,
		deployment.catalogEntry,
		deployment.pricing,
	);
	const candidate = {
		row: deployment,
		adapter,
		upstreamModel: deployment.upstreamModel,
		meta,
	} as DeploymentCandidate;
	return {
		handler: adapter.liveSession,
		ctx: {
			upstreamModel: deployment.upstreamModel,
			credentials: decryptRecord(
				deployment.credentials,
				"deployment-credentials",
			),
			meta,
			transport: resolveTransport(candidate, "live.session"),
			requestId: randomUUID(),
			signal,
		},
	};
}

function scopeKeyOf(c: Context<AppEnv>): string {
	const auth = getAuth(c);
	return auth.type === "virtual" ? auth.key.id : "master";
}

/**
 * Routes a new session (or a fork, pinned to its source's deployment) and runs `open` on the chosen
 * candidate. Logs and rethrows a failure to open.
 */
async function routeLiveSession<T>(
	c: Context<AppEnv>,
	body: Record<string, unknown>,
	transport: LiveTransport,
	source: LiveSessionRecord | null,
	open: (
		candidate: DeploymentCandidate,
		ctx: AdapterContext,
		upstreamBody: Record<string, unknown>,
	) => Promise<T>,
): Promise<{
	routing: RouteResult<T>;
	log: OperationLogDraft;
	session: Record<string, unknown>;
	publicModel: string;
	abort: AbortController;
}> {
	const session = record(body.session);
	if (!session) {
		throw badRequest("`session` must be an object.", "session");
	}
	const named = typeof session.model === "string" ? session.model : undefined;
	const publicModel = named ?? source?.publicModel;
	if (!publicModel) {
		throw badRequest(
			"`session.model` is required.",
			"session.model",
			"missing_required_parameter",
		);
	}
	const requestId = randomUUID();
	const log = new OperationLogDraft(c, "live.session", {
		publicModel,
		requestId,
	});
	log.requestBody = body;
	const abort = new AbortController();
	try {
		await preflight(c, publicModel, { writeHeaders: false });
		assertFinalModelAllowed(c, publicModel);
		const routing = await route(
			publicModel,
			"live.session",
			{
				clientSignal: abort.signal,
				requestId,
				operationId: log.operationId,
				executionMode: "stream",
				candidateEligibility: (candidate) => {
					if (source && candidate.row.id !== source.deploymentId) {
						throw badRequest(
							"A fork runs on its source session's deployment.",
							null,
							"unsupported_value",
						);
					}
					assertLiveSessionSupported(c, session, candidate, transport);
				},
				usageQuota: usageQuotaForRequest(c),
			},
			(candidate, ctx) =>
				open(
					candidate,
					ctx,
					named ? withUpstreamModel(body, ctx.upstreamModel) : body,
				),
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;
		return { routing, log, session, publicModel, abort };
	} catch (error) {
		const gatewayError = toGatewayError(error);
		log.applyFailedAttempts(gatewayError.attempts);
		log.writeError(gatewayError);
		abort.abort();
		throw gatewayError;
	}
}

function liveHandlerOf(candidate: DeploymentCandidate) {
	const handler = candidate.adapter.liveSession;
	if (!handler) {
		throw new GatewayError({
			class: "server",
			message: `Adapter "${candidate.adapter.key}" does not implement live sessions`,
		});
	}
	return handler;
}

/* ------------------------------------------------------------------ WebSocket sessions */

function sendText(socket: WSContext<RawSocket> | null, text: string): void {
	if (socket?.readyState !== 1) {
		return;
	}
	if ((socket.raw?.bufferedAmount ?? 0) > MAX_BUFFERED_SEND_BYTES) {
		socket.close(1008, "client is not reading");
		return;
	}
	socket.send(text);
}

/** A raw WebSocket message as text; binary frames are not GPT-Live events. */
function rawMessageText(data: unknown): string | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString("utf8");
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
			"utf8",
		);
	}
	return null;
}

function messageText(data: unknown): string {
	const text = rawMessageText(data);
	if (text === null) {
		throw badRequest("Live messages must be JSON text.", null, "invalid_event");
	}
	if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
		throw badRequest("Live message is too large.", null, "invalid_event");
	}
	return text;
}

function parseEvent(text: string): Record<string, unknown> {
	try {
		const event = record(JSON.parse(text));
		if (event) {
			return event;
		}
	} catch {
		// Reported below.
	}
	throw badRequest("Invalid JSON event.", null, "invalid_json");
}

interface LiveConnection {
	c: Context<AppEnv>;
	entry: RealtimeSocketEntry;
	upstream: LiveUpstream | null;
	run: LiveRun | null;
	publicModel: string;
	sessionId: string | null;
	pump: Promise<void> | null;
	queue: Promise<void>;
	queued: number;
	queuedBytes: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	stopCredentialWatch?: () => void;
	closed: boolean;
}

async function pumpSession(
	connection: LiveConnection,
	upstream: LiveUpstream,
	run: LiveRun,
): Promise<void> {
	try {
		for await (const frame of upstream.frames) {
			const exhausted = await run.observe(frame.event);
			sendText(
				connection.entry.socket,
				clientFrame(frame, connection.publicModel),
			);
			if (exhausted) {
				const error = budgetExceededError();
				sendText(
					connection.entry.socket,
					JSON.stringify(liveErrorEvent(error, null)),
				);
				upstream.close();
				await run.end(error, connection.sessionId);
				connection.entry.socket?.close(1008, "budget exceeded");
				return;
			}
		}
		await run.end(null, connection.sessionId);
		connection.entry.socket?.close(1000, "session closed");
	} catch (error) {
		const gatewayError = toGatewayError(error, "Live session failed");
		sendText(
			connection.entry.socket,
			JSON.stringify(liveErrorEvent(gatewayError, null)),
		);
		await run.end(gatewayError, connection.sessionId);
		connection.entry.socket?.close(1011, "upstream session failed");
	}
}

async function startSession(
	connection: LiveConnection,
	event: Record<string, unknown>,
	source: { sessionId: string; record: LiveSessionRecord } | null,
): Promise<void> {
	const { c } = connection;
	await revalidateConnection(c);
	const { routing, log, session, publicModel } = await routeLiveSession(
		c,
		event,
		"websocket",
		source?.record ?? null,
		(candidate, ctx, upstreamEvent) =>
			liveHandlerOf(candidate).start(upstreamEvent, ctx, source?.sessionId),
	);
	const upstream = routing.value;
	const run = new LiveRun(routing, log, session, "websocket");
	const started = record(upstream.started?.session);
	const sessionId = typeof started?.id === "string" ? started.id : null;
	connection.publicModel = publicModel;
	connection.sessionId = sessionId;
	if (sessionId) {
		await rememberLiveSession(
			sessionId,
			{
				deploymentId: routing.candidate.row.id,
				scopeKey: connection.entry.scopeKey,
				publicModel,
				upstreamModel: routing.candidate.upstreamModel,
			},
			started?.store === true,
		);
	}
	if (connection.closed) {
		upstream.close();
		await run.end(null, sessionId);
		return;
	}
	connection.upstream = upstream;
	connection.run = run;
	if (upstream.started) {
		sendText(
			connection.entry.socket,
			clientFrame(
				{ text: JSON.stringify(upstream.started), event: upstream.started },
				publicModel,
			),
		);
	}
	connection.pump = pumpSession(connection, upstream, run);
}

async function handleSessionMessage(
	connection: LiveConnection,
	data: unknown,
	source: { sessionId: string; record: LiveSessionRecord } | null,
): Promise<void> {
	let clientEventId: string | null = null;
	try {
		const text = messageText(data);
		const event = parseEvent(text);
		clientEventId = typeof event.event_id === "string" ? event.event_id : null;
		if (!connection.run) {
			if (event.type !== "session.start") {
				throw badRequest(
					"The first event must be session.start.",
					"type",
					"invalid_event",
				);
			}
			await startSession(connection, event, source);
			return;
		}
		if (event.type === "session.start") {
			throw badRequest(
				"The session has already started.",
				"type",
				"invalid_event",
			);
		}
		if (event.type === "session.update") {
			assertDelegatedModelsBillable(
				connection.c,
				record(event.session) ?? {},
				connection.run.routing.candidate.adapter.key,
			);
		}
		connection.upstream?.send(text);
	} catch (error) {
		sendText(
			connection.entry.socket,
			JSON.stringify(liveErrorEvent(toGatewayError(error), clientEventId)),
		);
	}
}

async function closeSession(connection: LiveConnection): Promise<void> {
	if (connection.closed) {
		return;
	}
	connection.closed = true;
	clearTimeout(connection.timer);
	connection.stopCredentialWatch?.();
	unregisterRealtimeSocket(connection.entry);
	await connection.queue.catch(() => undefined);
	const { upstream, run, pump } = connection;
	if (upstream && run && pump) {
		// Ask the provider to close so its final usage arrives, then stop waiting.
		if (!run.meter.closed) {
			upstream.send(JSON.stringify({ type: "session.close" }));
		}
		const timeout = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CLOSE_GRACE_MS);
			timer.unref?.();
		});
		await Promise.race([pump, timeout]);
		upstream.close();
		await run.end(null, connection.sessionId);
	}
}

function liveSessionSocket(
	c: Context<AppEnv>,
	source: { sessionId: string; record: LiveSessionRecord } | null,
): WSEvents<RawSocket> {
	const scopeKey = scopeKeyOf(c);
	assertRealtimeSocketCapacity(scopeKey);
	let connection: LiveConnection;
	const entry: RealtimeSocketEntry = {
		scopeKey,
		socket: null,
		busy: () => connection.run !== null,
		close: () => closeSession(connection),
	};
	connection = {
		c,
		entry,
		upstream: null,
		run: null,
		publicModel: "",
		sessionId: null,
		pump: null,
		queue: Promise.resolve(),
		queued: 0,
		queuedBytes: 0,
		timer: undefined,
		closed: false,
	};
	return {
		onOpen(_event, ws) {
			entry.socket = ws;
			if (!registerRealtimeSocket(entry)) {
				sendText(
					ws,
					JSON.stringify(liveErrorEvent(capacityLimitError(), null)),
				);
				connection.closed = true;
				ws.close(1013, "connection limit");
				return;
			}
			connection.timer = setTimeout(() => {
				connection.upstream?.send(JSON.stringify({ type: "session.close" }));
			}, LIVE_MAX_MS);
			connection.timer.unref?.();
			connection.stopCredentialWatch = watchCredential(c, (error) => {
				sendText(entry.socket, JSON.stringify(liveErrorEvent(error, null)));
				entry.socket?.close(1008, "credential revoked");
			});
		},
		onMessage(event) {
			if (connection.queued >= MAX_QUEUED_EVENTS) {
				sendText(
					entry.socket,
					JSON.stringify(liveErrorEvent(queuedBytesError(), null)),
				);
				return;
			}
			const admitted = admitQueuedBytes(connection, messageBytes(event.data));
			if (!admitted) {
				sendText(
					entry.socket,
					JSON.stringify(liveErrorEvent(queuedBytesError(), null)),
				);
				entry.socket?.close(1008, "too much queued data");
				return;
			}
			connection.queued += 1;
			connection.queue = connection.queue
				.then(() => handleSessionMessage(connection, event.data, source))
				.finally(() => {
					connection.queued -= 1;
					admitted.release();
				});
		},
		onClose() {
			void closeSession(connection);
		},
		onError() {
			void closeSession(connection);
		},
	};
}

/** GET /v1/live/sessions (WebSocket): a new session, configured by its first `session.start`. */
export const liveSessionsSocketHandler = upgradeWebSocket((c) => {
	assertWebSocketUpgrade(c);
	return liveSessionSocket(c, null);
});

/** GET /v1/live/sessions/{id}/fork (WebSocket): a new session continuing a stored one. */
export const liveForkSocketHandler = upgradeWebSocket(async (c) => {
	assertWebSocketUpgrade(c);
	const sessionId = c.req.param("id") ?? "";
	const found = await ownedSession(c, sessionId);
	return liveSessionSocket(c, { sessionId, record: found });
});

/* ------------------------------------------------------------------ sideband */

/**
 * GET /v1/live/sessions/{id}/attach (WebSocket): server-side control of a running session, relayed
 * to the provider's sideband. Not metered: the session it attaches to already is.
 */
export const liveAttachSocketHandler = upgradeWebSocket(async (c) => {
	assertWebSocketUpgrade(c);
	const sessionId = c.req.param("id") ?? "";
	const found = await ownedSession(c, sessionId);
	const abort = new AbortController();
	const { ctx, handler } = await sessionContext(found, abort.signal);
	if (!handler) {
		throw badRequest("Live sessions are not available.", null);
	}
	let upstream: LiveUpstream | null = null;
	let socket: WSContext<RawSocket> | null = null;
	const pending: string[] = [];
	let closed = false;
	const close = () => {
		if (closed) {
			return;
		}
		closed = true;
		upstream?.close();
		abort.abort();
	};
	return {
		onOpen(_event, ws) {
			socket = ws;
			handler.attach(sessionId, ctx).then(
				async (opened) => {
					if (closed) {
						opened.close();
						return;
					}
					upstream = opened;
					for (const text of pending.splice(0)) {
						opened.send(text);
					}
					try {
						for await (const frame of opened.frames) {
							sendText(socket, clientFrame(frame, found.publicModel));
						}
						socket?.close(1000, "session closed");
					} catch (error) {
						sendText(
							socket,
							JSON.stringify(liveErrorEvent(toGatewayError(error), null)),
						);
						socket?.close(1011, "upstream sideband failed");
					}
				},
				(error) => {
					sendText(
						socket,
						JSON.stringify(liveErrorEvent(toGatewayError(error), null)),
					);
					socket?.close(1011, "upstream sideband failed");
				},
			);
		},
		onMessage(event) {
			try {
				const text = messageText(event.data);
				if (upstream) {
					upstream.send(text);
				} else {
					pending.push(text);
				}
			} catch (error) {
				sendText(
					socket,
					JSON.stringify(liveErrorEvent(toGatewayError(error), null)),
				);
			}
		},
		onClose: close,
		onError: close,
	};
});

/* ------------------------------------------------------------------ WebRTC and SIP */

/**
 * Meters a WebRTC or SIP session from its sideband: media flows between the client and the
 * provider, so the provider's usage events are the only record of what it cost.
 */
async function meterFromSideband(
	run: LiveRun,
	sideband: LiveUpstream | null,
	sessionId: string,
	abort: AbortController,
): Promise<void> {
	if (!sideband) {
		await run.end(
			new GatewayError({
				class: "server",
				code: "live_metering_unavailable",
				message: `Could not attach to live session ${sessionId} to meter it`,
			}),
			sessionId,
		);
		abort.abort();
		return;
	}
	try {
		for await (const frame of sideband.frames) {
			if (await run.observe(frame.event)) {
				sideband.send(JSON.stringify({ type: "session.close" }));
			}
			if (frame.event.type === "session.closed") {
				break;
			}
		}
		await run.end(null, sessionId);
	} catch (error) {
		await run.end(
			toGatewayError(error, "Live session metering failed"),
			sessionId,
		);
	} finally {
		sideband.close();
		abort.abort();
	}
}

async function createOverHttp(
	c: Context<AppEnv>,
	source: { sessionId: string; record: LiveSessionRecord } | null,
): Promise<Response> {
	const body = record(await readJsonBody(c, PUBLIC_JSON_BODY_MAX_BYTES));
	if (!body) {
		throw badRequest("The body must be a JSON object.", null);
	}
	const transportType = record(body.transport)?.type;
	if (transportType !== "webrtc" && transportType !== "sip") {
		throw badRequest(
			"`transport.type` must be `webrtc` or `sip`.",
			"transport.type",
			"invalid_value",
		);
	}
	const { routing, log, session, publicModel, abort } = await routeLiveSession(
		c,
		body,
		transportType,
		source?.record ?? null,
		async (candidate, ctx, upstreamBody) => {
			const handler = liveHandlerOf(candidate);
			const created = await handler.create(
				upstreamBody,
				ctx,
				source?.sessionId,
			);
			const id = record(created.body.session)?.id;
			// Attach while this attempt's context is live, so metering uses the same credentials.
			const sideband =
				typeof id === "string"
					? await handler.attach(id, ctx).catch(() => null)
					: null;
			return { created, sideband };
		},
	);
	const { created, sideband } = routing.value;
	const sessionId = String(record(created.body.session)?.id ?? "");
	if (sessionId) {
		await rememberLiveSession(
			sessionId,
			{
				deploymentId: routing.candidate.row.id,
				scopeKey: scopeKeyOf(c),
				publicModel,
				upstreamModel: routing.candidate.upstreamModel,
			},
			session.store === true,
		);
	}
	const run = new LiveRun(routing, log, session, transportType);
	void meterFromSideband(run, sideband, sessionId, abort).catch((error) =>
		logger.error("live", "metering failed", {
			sessionId,
			error: String(error),
		}),
	);
	return c.json(created.body, created.status as 200 | 201);
}

/** POST /v1/live/sessions: a WebRTC or SIP session. */
export function liveCreateHandler(c: Context<AppEnv>): Promise<Response> {
	return createOverHttp(c, null);
}

/** POST /v1/live/sessions/{id}/fork: a WebRTC fork of a stored session. */
export async function liveForkHandler(c: Context<AppEnv>): Promise<Response> {
	const sessionId = c.req.param("id") ?? "";
	const found = await ownedSession(c, sessionId);
	return createOverHttp(c, { sessionId, record: found });
}

/** GET /v1/live/sessions/{id}/content: a stored session's recording, streamed from the provider. */
export async function liveContentHandler(
	c: Context<AppEnv>,
): Promise<Response> {
	const sessionId = c.req.param("id") ?? "";
	const found = await ownedSession(c, sessionId);
	const abort = new AbortController();
	c.req.raw.signal.addEventListener("abort", () => abort.abort(), {
		once: true,
	});
	const { ctx, handler } = await sessionContext(found, abort.signal);
	if (!handler) {
		throw badRequest("Live sessions are not available.", null);
	}
	const upstream = await handler.content(sessionId, ctx);
	const headers = new Headers();
	for (const name of [
		"content-type",
		"content-length",
		"content-disposition",
	]) {
		const value = upstream.headers.get(name);
		if (value) {
			headers.set(name, value);
		}
	}
	return new Response(upstream.body, { status: upstream.status, headers });
}
