import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { RealtimeTranslationSession } from "#adapters/types.ts";
import { realtimeTranslationProfileFor } from "#catalog/types.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { completedTerminal } from "#gateway/streamLifecycle.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import { route, type RouteResult } from "#router/index.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { upgradeWebSocket } from "#http/bunServer.ts";
import { pricingAt } from "#catalog/pricing.ts";
import { computeCost } from "#logging/cost.ts";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { RawSocket } from "#http/bunServer.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";
import type { WSEvents } from "hono/ws";
import type { Context } from "hono";

import {
	type CanonicalRealtimeTranslationConfig,
	type CanonicalRealtimeTranslationEvent,
	TRANSLATION_AUDIO_RATE,
} from "#core/realtimeTranslation.ts";

import {
	addRealtimeUsage,
	realtimeUsageToCore,
	type RealtimeUsage,
} from "#core/realtime.ts";

import {
	assertRealtimeSocketCapacity,
	type RealtimeSocketEntry,
	unregisterRealtimeSocket,
	assertWebSocketUpgrade,
	registerRealtimeSocket,
	revalidateConnection,
	eventQueueLimitError,
	sessionExpiredError,
	realtimeMessageJson,
	capacityLimitError,
	sendRealtimeEvent,
	MAX_QUEUED_EVENTS,
	admitQueuedBytes,
	queuedBytesError,
	REALTIME_MAX_MS,
	watchCredential,
	messageBytes,
} from "./realtimeSockets.ts";

import {
	assertRealtimeExtensionsSupported,
	assertFinalModelAllowed,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	preflight,
} from "./runtime/pipeline.ts";

import {
	type TranslationSessionState,
	applyTranslationSessionUpdate,
	translationClientEventSchema,
	newTranslationSessionState,
	renderTranslationSession,
	translationConfigOf,
	translationEventId,
} from "#contracts/openai/realtimeTranslation.ts";

/**
 * GET /v1/realtime/translations?model=… (WebSocket): OpenAI's realtime speech translation, served
 * by any adapter with a translation handler (OpenAI and Azure natively, Gemini Live in translation
 * mode).
 *
 * The provider session opens with the first audio, configured by the `session.update`s before it.
 * The connection is one routed operation, logged when it closes. A model priced by the second is
 * billed on the seconds of audio forwarded; a token-priced one on the provider's usage, or on an
 * estimate from the audio in both directions when the provider reports none. A source transcript that
 * runs on a separate model is billed against that model too.
 */

/** Bytes per second of the contract's audio: 16-bit mono at 24 kHz. */
const BYTES_PER_SECOND = TRANSLATION_AUDIO_RATE * 2;
/** Gemini bills live audio at 25 tokens per second, in and out. */
const ESTIMATED_AUDIO_TOKENS_PER_SECOND = 25;
/** A long session is charged every this many seconds of audio. */
const CHARGE_EVERY_SECONDS = 10;

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

/**
 * Refuses, for one candidate, a configuration it cannot serve or the gateway cannot bill: a target
 * language outside its list, a source transcript it does not produce, or a separate transcript
 * model the key may not use or the catalog does not price.
 */
function assertTranslationSupported(
	c: Context<AppEnv>,
	config: CanonicalRealtimeTranslationConfig,
	candidate: DeploymentCandidate,
): void {
	const profile = realtimeTranslationProfileFor(candidate.meta);
	if (!profile) {
		throw badRequest(
			`Model ${config.model} does not translate speech.`,
			"model",
			"unsupported_model",
		);
	}
	if (
		config.language &&
		profile.languages &&
		!profile.languages.includes(config.language)
	) {
		throw badRequest(
			`Model ${config.model} does not translate into '${config.language}'.`,
			"session.audio.output.language",
			"unsupported_value",
		);
	}
	if (config.inputTranscription && !profile.supportsInputTranscription) {
		throw badRequest(
			`Model ${config.model} does not transcribe the source speech.`,
			"session.audio.input.transcription",
			"unsupported_value",
		);
	}
	const transcriptionModel = config.inputTranscription?.model;
	if (profile.separateInputTranscription && transcriptionModel) {
		assertFinalModelAllowed(c, transcriptionModel);
		if (
			!resolveModelMetadata(candidate.adapter.key, transcriptionModel).pricing
		) {
			throw badRequest(
				`The gateway has no price for transcription model ${transcriptionModel}, so it cannot bill it.`,
				"session.audio.input.transcription.model",
				"unsupported_model",
			);
		}
	}
}

interface TranslationRun {
	session: RealtimeTranslationSession;
	routing: RouteResult<RealtimeTranslationSession>;
	log: OperationLogDraft;
	abort: AbortController;
	configKey: string;
	usage: RealtimeUsage | null;
	inputSeconds: number;
	outputSeconds: number;
	/** Seconds of audio sent while a separately billed source transcript was on. */
	transcribedSeconds: number;
	/** The source transcript model the session last named, billed when the profile says so. */
	transcriptionModel: string | null;
	chargedAtSeconds: number;
	ended: boolean;
	pump: Promise<void> | null;
}

interface TranslationConnection {
	c: Context<AppEnv>;
	entry: RealtimeSocketEntry;
	state: TranslationSessionState;
	run: TranslationRun | null;
	failed: GatewayError | null;
	queue: Promise<void>;
	queued: number;
	queuedBytes: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	stopCredentialWatch?: () => void;
	closed: boolean;
}

function send(
	connection: TranslationConnection,
	value: Record<string, unknown>,
): void {
	sendRealtimeEvent(connection.entry.socket, value);
}

function sendError(
	connection: TranslationConnection,
	error: GatewayError,
	clientEventId: string | null = null,
): void {
	const body = error.toOpenAI().error;
	send(connection, {
		type: "error",
		event_id: translationEventId(),
		error: {
			type: body.type,
			code: body.code ?? null,
			message: body.message,
			param: body.param ?? null,
			event_id: clientEventId,
		},
	});
}

/** The run's billable usage: seconds, the provider's tokens (or an estimate), and delegated work. */
function runUsage(run: TranslationRun): { usage: Usage; estimated: boolean } {
	const { meta, adapter } = run.routing.candidate;
	const perSecond =
		pricingAt(meta.pricing)?.audioInputCentsPerSecond !== undefined;
	let tokens = realtimeUsageToCore(run.usage);
	let estimated = false;
	if (!(tokens || perSecond)) {
		const input = Math.ceil(
			run.inputSeconds * ESTIMATED_AUDIO_TOKENS_PER_SECOND,
		);
		const output = Math.ceil(
			run.outputSeconds * ESTIMATED_AUDIO_TOKENS_PER_SECOND,
		);
		tokens = {
			promptTokens: input,
			completionTokens: output,
			totalTokens: input + output,
			promptAudioTokens: input,
			completionAudioTokens: output,
		};
		estimated = input + output > 0;
	}
	const transcription = realtimeTranslationProfileFor(meta)
		?.separateInputTranscription
		? run.transcriptionModel
		: null;
	const delegated =
		transcription && run.transcribedSeconds > 0
			? computeCost(resolveModelMetadata(adapter.key, transcription), {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					inputAudioSeconds: run.transcribedSeconds,
				}).totalCents
			: 0;
	return {
		usage: {
			...(tokens ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
			inputAudioSeconds: Math.round(run.inputSeconds * 1000) / 1000,
			...(delegated > 0 ? { delegatedCostCents: delegated } : {}),
		},
		estimated,
	};
}

function budgetExceededError(): GatewayError {
	return new GatewayError({
		class: "rate_limit",
		code: "budget_exceeded",
		message:
			"Budget exhausted for this API key during the realtime translation",
		failureKind: "request",
		deploymentHealth: "neutral",
	});
}

async function charge(
	connection: TranslationConnection,
	run: TranslationRun,
): Promise<void> {
	run.chargedAtSeconds = run.inputSeconds;
	const { budgetExhausted } = await run.routing.charge(runUsage(run).usage);
	if (budgetExhausted) {
		sendError(connection, budgetExceededError());
		await endRun(connection, run, budgetExceededError());
		connection.entry.socket?.close(1008, "budget exceeded");
	}
}

async function endRun(
	connection: TranslationConnection,
	run: TranslationRun,
	error: GatewayError | null,
): Promise<void> {
	if (run.ended) {
		return;
	}
	run.ended = true;
	if (connection.run === run) {
		connection.run = null;
	}
	run.session.close();
	run.abort.abort();
	const { usage, estimated } = runUsage(run);
	const terminal = error ? null : completedTerminal(usage);
	await run.routing.finish(usage, undefined, error, terminal);
	run.log.write({
		status: error ? "error" : "success",
		httpStatus: error?.httpStatus ?? 200,
		usage,
		cost: computeUsageCost(run.routing.candidate.meta, usage),
		firstOutputMs: null,
		responseBody: {
			streamed: true,
			inputAudioSeconds: Math.round(run.inputSeconds * 1000) / 1000,
			outputAudioSeconds: Math.round(run.outputSeconds * 1000) / 1000,
		},
		metadata: {
			...candidateMetadata(run.routing.candidate),
			...(terminal ? { terminal } : {}),
			...(estimated ? { usageEstimated: true } : {}),
		},
		error: error ? error.toLog() : null,
	});
}

function elapsed(
	run: TranslationRun,
	given: number | null | undefined,
): number {
	if (typeof given === "number") {
		return given;
	}
	return Math.floor((run.inputSeconds * 1000) / 200) * 200;
}

function render(
	run: TranslationRun,
	event: CanonicalRealtimeTranslationEvent,
): Record<string, unknown> | null {
	switch (event.kind) {
		case "input_transcript":
			return {
				type: "session.input_transcript.delta",
				event_id: translationEventId(),
				delta: event.text,
				elapsed_ms: elapsed(run, event.elapsedMs),
			};
		case "output_transcript":
			return {
				type: "session.output_transcript.delta",
				event_id: translationEventId(),
				delta: event.text,
				elapsed_ms: elapsed(run, event.elapsedMs),
			};
		case "output_audio":
			return {
				type: "session.output_audio.delta",
				event_id: translationEventId(),
				delta: event.pcm.toString("base64"),
				format: "pcm16",
				sample_rate: TRANSLATION_AUDIO_RATE,
				channels: 1,
				elapsed_ms: elapsed(run, event.elapsedMs),
			};
		default:
			return null;
	}
}

async function pump(
	connection: TranslationConnection,
	run: TranslationRun,
): Promise<void> {
	try {
		for await (const event of run.session.events) {
			run.log.progress();
			if (event.kind === "usage") {
				run.usage = addRealtimeUsage(run.usage, event.usage);
				await charge(connection, run);
				continue;
			}
			if (event.kind === "provider_error") {
				sendError(
					connection,
					new GatewayError({
						class: "bad_request",
						code: event.code ?? "provider_error",
						message: "The provider refused an event",
						publicMessage: "The provider refused an event.",
					}),
				);
				continue;
			}
			if (event.kind === "output_audio") {
				run.outputSeconds += event.pcm.byteLength / BYTES_PER_SECOND;
			}
			const rendered = render(run, event);
			if (rendered) {
				send(connection, rendered);
			}
		}
	} catch (error) {
		if (run.ended) {
			return;
		}
		const gatewayError = toGatewayError(error, "Realtime translation failed");
		sendError(connection, gatewayError);
		await endRun(connection, run, gatewayError);
		connection.entry.socket?.close(1011, "upstream session failed");
	}
}

async function startRun(
	connection: TranslationConnection,
): Promise<TranslationRun> {
	const { c } = connection;
	const config = translationConfigOf(connection.state);
	const requestId = randomUUID();
	const log = new OperationLogDraft(c, "realtime.translation", {
		publicModel: config.model,
		requestId,
	});
	log.requestBody = { session: renderTranslationSession(connection.state) };
	const abort = new AbortController();
	try {
		await revalidateConnection(c);
		assertRealtimeExtensionsSupported(c, "realtime.translation", config.model);
		await preflight(c, config.model, { writeHeaders: false });
		assertFinalModelAllowed(c, config.model);
		const routing = await route(
			config.model,
			"realtime.translation",
			{
				clientSignal: abort.signal,
				requestId,
				operationId: log.operationId,
				executionMode: "stream",
				candidateEligibility: (candidate) =>
					assertTranslationSupported(c, config, candidate),
				usageQuota: usageQuotaForRequest(c),
			},
			(candidate, ctx) => {
				const handler = candidate.adapter.realtimeTranslation;
				if (!handler) {
					throw new GatewayError({
						class: "server",
						message: `Adapter "${candidate.adapter.key}" does not implement realtime translation`,
					});
				}
				return handler.connect(config, ctx);
			},
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;
		const run: TranslationRun = {
			session: routing.value,
			routing,
			log,
			abort,
			configKey: JSON.stringify(config),
			usage: null,
			inputSeconds: 0,
			outputSeconds: 0,
			transcribedSeconds: 0,
			transcriptionModel: config.inputTranscription?.model ?? null,
			chargedAtSeconds: 0,
			ended: false,
			pump: null,
		};
		return run;
	} catch (error) {
		const gatewayError = toGatewayError(error);
		log.applyFailedAttempts(gatewayError.attempts);
		log.writeError(gatewayError);
		throw gatewayError;
	}
}

async function ensureRun(
	connection: TranslationConnection,
): Promise<TranslationRun> {
	if (connection.run) {
		return connection.run;
	}
	if (connection.failed) {
		throw connection.failed;
	}
	let run: TranslationRun;
	try {
		run = await startRun(connection);
	} catch (error) {
		connection.failed = toGatewayError(error);
		throw connection.failed;
	}
	if (connection.closed) {
		await endRun(connection, run, null);
		throw new GatewayError({
			class: "server",
			message: "Realtime socket closed",
		});
	}
	connection.run = run;
	run.pump = pump(connection, run);
	return run;
}

async function handleMessage(
	connection: TranslationConnection,
	data: unknown,
): Promise<void> {
	let clientEventId: string | null = null;
	try {
		const raw = realtimeMessageJson(data);
		const parsed = translationClientEventSchema.safeParse(raw);
		if (!parsed.success) {
			const type = (raw as { type?: unknown } | null)?.type;
			clientEventId =
				typeof (raw as { event_id?: unknown } | null)?.event_id === "string"
					? String((raw as { event_id: string }).event_id)
					: null;
			throw badRequest(
				typeof type === "string" &&
					![
						"session.update",
						"session.input_audio_buffer.append",
						"session.close",
					].includes(type)
					? `Unknown event type '${type}'.`
					: (parsed.error.issues[0]?.message ?? "Invalid event."),
				null,
				"invalid_event",
			);
		}
		const event = parsed.data;
		clientEventId = event.event_id ?? null;
		if (event.type === "session.update") {
			if (
				event.session.model !== undefined &&
				event.session.model !== connection.state.model
			) {
				throw badRequest(
					"The session model cannot be changed.",
					"session.model",
					"invalid_value",
				);
			}
			const next = applyTranslationSessionUpdate(
				connection.state,
				event.session,
			);
			const config = translationConfigOf(next);
			const { run } = connection;
			if (run) {
				assertTranslationSupported(connection.c, config, run.routing.candidate);
				const configKey = JSON.stringify(config);
				if (configKey !== run.configKey) {
					await run.session.reconfigure(config);
					run.configKey = configKey;
					run.transcriptionModel = config.inputTranscription?.model ?? null;
				}
			}
			connection.state = next;
			connection.failed = null;
			send(connection, {
				type: "session.updated",
				event_id: translationEventId(),
				session: renderTranslationSession(next),
			});
			return;
		}
		if (event.type === "session.input_audio_buffer.append") {
			const pcm = Buffer.from(event.audio, "base64");
			const run = await ensureRun(connection);
			const seconds = pcm.byteLength / BYTES_PER_SECOND;
			run.inputSeconds += seconds;
			if (connection.state.transcription) {
				run.transcribedSeconds += seconds;
			}
			run.session.appendAudio(pcm);
			if (run.inputSeconds - run.chargedAtSeconds >= CHARGE_EVERY_SECONDS) {
				await charge(connection, run);
			}
			return;
		}
		// session.close: let the provider drain its output, then end.
		const { run } = connection;
		if (run) {
			await run.session.finish();
			await endRun(connection, run, null);
		}
		send(connection, {
			type: "session.closed",
			event_id: translationEventId(),
		});
		connection.entry.socket?.close(1000, "session closed");
	} catch (error) {
		sendError(connection, toGatewayError(error), clientEventId);
	}
}

async function closeConnection(
	connection: TranslationConnection,
): Promise<void> {
	if (connection.closed) {
		return;
	}
	connection.closed = true;
	clearTimeout(connection.timer);
	connection.stopCredentialWatch?.();
	unregisterRealtimeSocket(connection.entry);
	if (connection.run) {
		await endRun(connection, connection.run, null);
	}
	await connection.queue.catch(() => undefined);
}

function realtimeTranslationSocket(
	c: Context<AppEnv>,
	scopeKey: string,
	model: string,
): WSEvents<RawSocket> {
	assertRealtimeSocketCapacity(scopeKey);
	let connection: TranslationConnection;
	const entry: RealtimeSocketEntry = {
		scopeKey,
		socket: null,
		busy: () => connection.run !== null,
		close: () => closeConnection(connection),
	};
	connection = {
		c,
		entry,
		state: newTranslationSessionState(
			model,
			Math.floor((Date.now() + REALTIME_MAX_MS) / 1000),
		),
		run: null,
		failed: null,
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
				sendError(connection, capacityLimitError());
				connection.closed = true;
				ws.close(1013, "connection limit");
				return;
			}
			send(connection, {
				type: "session.created",
				event_id: translationEventId(),
				session: renderTranslationSession(connection.state),
			});
			connection.timer = setTimeout(() => {
				sendError(connection, sessionExpiredError());
				entry.socket?.close(1000, "60 minute session limit");
			}, REALTIME_MAX_MS);
			connection.timer.unref?.();
			connection.stopCredentialWatch = watchCredential(c, (error) => {
				sendError(connection, error);
				entry.socket?.close(1008, "credential revoked");
			});
		},
		onMessage(event) {
			if (connection.queued >= MAX_QUEUED_EVENTS) {
				sendError(connection, eventQueueLimitError());
				return;
			}
			const admitted = admitQueuedBytes(connection, messageBytes(event.data));
			if (!admitted) {
				sendError(connection, queuedBytesError());
				connection.entry.socket?.close(1008, "too much queued data");
				return;
			}
			connection.queued += 1;
			connection.queue = connection.queue
				.then(() => handleMessage(connection, event.data))
				.finally(() => {
					connection.queued -= 1;
					admitted.release();
				});
		},
		onClose() {
			void closeConnection(connection);
		},
		onError() {
			void closeConnection(connection);
		},
	};
}

/** GET /v1/realtime/translations?model=… with Upgrade: websocket. */
export const realtimeTranslationsHandler = upgradeWebSocket((c) => {
	assertWebSocketUpgrade(c);
	const model = c.req.query("model");
	if (!model) {
		throw badRequest(
			"Connect with ?model=<model> for a realtime translation.",
			"model",
			"missing_required_parameter",
		);
	}
	const auth = getAuth(c);
	return realtimeTranslationSocket(
		c,
		auth.type === "virtual" ? auth.key.id : "master",
		model,
	);
});
