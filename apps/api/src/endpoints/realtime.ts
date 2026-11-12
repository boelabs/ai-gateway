import { realtimeConversationSessionSchema } from "#contracts/openai/realtimeConversation.ts";
import { assertRealtimeConfigSupported } from "#gateway/realtimeRequestValidation.ts";
import { RealtimeTranscriptTracker } from "#contracts/openai/realtimeTranscript.ts";
import { type AudioInputDecoder, createAudioInputDecoder } from "#audio/pcm.ts";
import type { RealtimeTranscriptionSession } from "#adapters/types.ts";
import { realtimeConversationSocket } from "./realtimeConversation.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { completedTerminal } from "#gateway/streamLifecycle.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import { route, type RouteResult } from "#router/index.ts";
import { upgradeWebSocket } from "@hono/node-server";
import { GatewayError } from "#core/errors.ts";
import { getAuth } from "#auth/middleware.ts";
import type { AppEnv } from "#auth/types.ts";
import { randomUUID } from "node:crypto";
import type { WSEvents } from "hono/ws";
import type { Context } from "hono";
import { z } from "zod/v4";

import {
	assertRealtimeSocketCapacity,
	type RealtimeSocketEntry,
	unregisterRealtimeSocket,
	assertWebSocketUpgrade,
	registerRealtimeSocket,
	eventQueueLimitError,
	revalidateConnection,
	sessionExpiredError,
	realtimeMessageJson,
	capacityLimitError,
	sendRealtimeEvent,
	MAX_QUEUED_EVENTS,
	admitQueuedBytes,
	queuedBytesError,
	messageBytes,
	REALTIME_MAX_MS,
	watchCredential,
} from "./realtimeSockets.ts";

import {
	realtimeTranscriptionSessionSchema,
	type RealtimeSessionUpdate,
	type RealtimeSessionState,
	RealtimeClientEventError,
	parseRealtimeClientEvent,
	newRealtimeSessionState,
	realtimeErrorEvent,
	applySessionUpdate,
	realtimeConfigOf,
	INTERIM_INCLUDE,
	renderSession,
	eventId,
} from "#contracts/openai/realtime.ts";

import {
	assertRealtimeExtensionsSupported,
	assertFinalModelAllowed,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	preflight,
} from "./runtime/pipeline.ts";

import {
	type CanonicalRealtimeTranscriptionConfig,
	realtimeUsageToCore,
	type RealtimeUsage,
	addRealtimeUsage,
} from "#core/realtime.ts";

import {
	finishDownstreamWriteObservation,
	type DownstreamWriteObservation,
	newDownstreamWriteObservation,
} from "./runtime/sse.ts";

export { closeRealtimeWebSockets } from "./realtimeSockets.ts";

/**
 * GET /v1/realtime with Upgrade: websocket — OpenAI's Realtime API. `?model=…` opens a conversation
 * (see realtimeConversation.ts); `?intent=transcription` a transcription session, served by any
 * adapter with a realtime transcription handler.
 *
 * Each transcription provider session is one routed operation: it starts when a `session.update`
 * names a model (or changes how that model must be configured) and ends when the configuration
 * changes again or the socket closes. Its usage and cost are logged once, at the end.
 */

/**
 * Usage estimates for providers that report none (Gemini Live sends no `usageMetadata` for
 * transcription-only sessions): Google bills live audio at 25 tokens per second, and Gemini
 * Transcribe's text runs about 4 characters per output token.
 */
const ESTIMATED_AUDIO_TOKENS_PER_SECOND = 25;
const ESTIMATED_CHARACTERS_PER_OUTPUT_TOKEN = 4;

interface UpstreamRun {
	configKey: string;
	config: CanonicalRealtimeTranscriptionConfig;
	session: RealtimeTranscriptionSession;
	routing: RouteResult<RealtimeTranscriptionSession>;
	log: OperationLogDraft;
	abort: AbortController;
	decoder: AudioInputDecoder;
	/** Seconds of audio received before the current decoder (a format change replaces it). */
	secondsBefore: number;
	usage: RealtimeUsage | null;
	tracker: RealtimeTranscriptTracker;
	downstream: DownstreamWriteObservation;
	ended: boolean;
	/** Completed transcript items and usage reports already charged against the key. */
	chargedItems: number;
	chargedUsage: RealtimeUsage | null;
}

interface RealtimeConnection {
	c: Context<AppEnv>;
	entry: RealtimeSocketEntry;
	state: RealtimeSessionState;
	queue: Promise<void>;
	queued: number;
	queuedBytes: number;
	run: UpstreamRun | null;
	lastItemId: string | null;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Stops the periodic credential re-check (see `watchCredential`). */
	stopCredentialWatch?: () => void;
	closed: boolean;
}

function send(
	connection: RealtimeConnection,
	value: Record<string, unknown>,
	downstream?: DownstreamWriteObservation,
): void {
	sendRealtimeEvent(connection.entry.socket, value, downstream);
}

function sendError(
	connection: RealtimeConnection,
	error: GatewayError,
	clientEventId: string | null = null,
): void {
	const body = error.toOpenAI().error;
	send(
		connection,
		realtimeErrorEvent({
			type: body.type,
			code: body.code ?? null,
			message: body.message,
			param: body.param ?? null,
			eventId: clientEventId,
		}),
	);
}

function runSeconds(run: UpstreamRun): number {
	return run.secondsBefore + run.decoder.seconds;
}

/* ------------------------------------------------------------------ provider runs */

async function pump(connection: RealtimeConnection, run: UpstreamRun) {
	try {
		for await (const event of run.session.events) {
			run.log.progress();
			if (event.kind === "usage") {
				run.usage = addRealtimeUsage(run.usage, event.usage);
			}
			run.tracker.provider(event);
			if (await budgetExhaustedAfterCharge(run)) {
				const exhausted = new GatewayError({
					class: "rate_limit",
					code: "budget_exceeded",
					message:
						"Budget exhausted for this API key during the realtime session",
					failureKind: "request",
					deploymentHealth: "neutral",
				});
				sendError(connection, exhausted);
				await endRun(connection, run, exhausted);
				connection.entry.socket?.close(1008, "budget exceeded");
				return;
			}
		}
		await endRun(connection, run, null);
	} catch (error) {
		if (run.ended) {
			return;
		}
		const gatewayError = toGatewayError(error, "Realtime transcription failed");
		sendError(connection, gatewayError);
		await endRun(connection, run, gatewayError);
		connection.entry.socket?.close(1011, "upstream session failed");
	}
}

/** The run's usage so far: the provider's reports, or an estimate from the audio received. */
function runUsage(run: UpstreamRun): {
	usage: RealtimeUsage | null;
	estimated: boolean;
} {
	const seconds = runSeconds(run);
	if (run.usage || seconds <= 0) {
		return { usage: run.usage, estimated: false };
	}
	const audioTokens = Math.ceil(seconds * ESTIMATED_AUDIO_TOKENS_PER_SECOND);
	const outputTokens = Math.ceil(
		run.tracker.transcriptCharacters / ESTIMATED_CHARACTERS_PER_OUTPUT_TOKEN,
	);
	return {
		usage: {
			inputTokens: audioTokens,
			outputTokens,
			totalTokens: audioTokens + outputTokens,
			audioTokens,
		},
		estimated: true,
	};
}

/**
 * Charges the run as it goes, at each usage report or completed transcript, so a long session is
 * billed in the current TPM window and stopped once the budget is spent.
 */
async function budgetExhaustedAfterCharge(run: UpstreamRun): Promise<boolean> {
	if (
		run.usage === run.chargedUsage &&
		run.tracker.completedItems === run.chargedItems
	) {
		return false;
	}
	run.chargedUsage = run.usage;
	run.chargedItems = run.tracker.completedItems;
	const core = realtimeUsageToCore(runUsage(run).usage);
	if (!core) {
		return false;
	}
	const { budgetExhausted } = await run.routing.charge(core);
	return budgetExhausted;
}

async function endRun(
	connection: RealtimeConnection,
	run: UpstreamRun,
	error: GatewayError | null,
): Promise<void> {
	if (run.ended) {
		return;
	}
	run.ended = true;
	if (connection.run === run) {
		connection.run = null;
	}
	run.tracker.finish();
	connection.lastItemId = run.tracker.lastItemId;
	run.session.close();
	run.abort.abort();
	const seconds = runSeconds(run);
	const { usage, estimated } = runUsage(run);
	const core = realtimeUsageToCore(usage);
	const terminal = error ? null : completedTerminal(core);
	await run.routing.finish(core, undefined, error, terminal, run.downstream);
	finishDownstreamWriteObservation(run.downstream, error?.code);
	run.log.write({
		status: error ? "error" : "success",
		httpStatus: error?.httpStatus ?? 200,
		usage: core,
		cost: computeUsageCost(run.routing.candidate.meta, core),
		firstOutputMs:
			run.tracker.firstOutputAt === null
				? null
				: run.tracker.firstOutputAt - run.log.startedAt,
		responseBody: {
			streamed: true,
			items: run.tracker.completedItems,
			audioSeconds: Math.round(seconds * 1000) / 1000,
		},
		metadata: {
			...candidateMetadata(run.routing.candidate),
			...(terminal ? { terminal } : {}),
			turnDetection: run.config.turnDetection,
			...(estimated ? { usageEstimated: true } : {}),
		},
		error: error ? error.toLog() : null,
	});
}

async function startRun(
	connection: RealtimeConnection,
	config: CanonicalRealtimeTranscriptionConfig,
	configKey: string,
	state: RealtimeSessionState,
): Promise<UpstreamRun> {
	const { c } = connection;
	const requestId = randomUUID();
	const log = new OperationLogDraft(c, "realtime.transcription", {
		publicModel: config.model,
		requestId,
	});
	log.requestBody = { session: renderSession(state) };
	const abort = new AbortController();
	try {
		await revalidateConnection(c);
		assertRealtimeExtensionsSupported(
			c,
			"realtime.transcription",
			config.model,
		);
		await preflight(c, config.model, { writeHeaders: false });
		assertFinalModelAllowed(c, config.model);
		const routing = await route(
			config.model,
			"realtime.transcription",
			{
				clientSignal: abort.signal,
				requestId,
				operationId: log.operationId,
				executionMode: "stream",
				candidateEligibility: (candidate) =>
					assertRealtimeConfigSupported(config, candidate.meta),
				usageQuota: usageQuotaForRequest(c),
			},
			(candidate, ctx) => {
				const handler = candidate.adapter.realtimeTranscription;
				if (!handler) {
					throw new GatewayError({
						class: "server",
						message: `Adapter "${candidate.adapter.key}" does not implement realtime transcription`,
					});
				}
				return handler.connect(config, ctx);
			},
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;
		const downstream = newDownstreamWriteObservation(log.operationId);
		const run: UpstreamRun = {
			configKey,
			config,
			session: routing.value,
			routing,
			log,
			abort,
			decoder: createAudioInputDecoder(state.format),
			secondsBefore: 0,
			usage: null,
			downstream,
			ended: false,
			chargedItems: 0,
			chargedUsage: null,
			tracker: new RealtimeTranscriptTracker({
				turnDetection: config.turnDetection,
				previousItemId: connection.lastItemId,
				includeInterim: () =>
					connection.state.include.includes(INTERIM_INCLUDE),
				audioMs: () => Math.round(runSeconds(run) * 1000),
				emit: (event) => send(connection, event, downstream),
			}),
		};
		return run;
	} catch (error) {
		const gatewayError = toGatewayError(error);
		log.applyFailedAttempts(gatewayError.attempts);
		log.writeError(gatewayError);
		throw gatewayError;
	}
}

/* ------------------------------------------------------------------ client events */

async function updateSession(
	connection: RealtimeConnection,
	state: RealtimeSessionState,
): Promise<void> {
	const { run } = connection;
	const config = realtimeConfigOf(state);
	const configKey = config ? JSON.stringify(config) : "";
	if (config && configKey !== run?.configKey) {
		// The provider fixes its configuration when the session opens: a change means a new one.
		if (run) {
			await endRun(connection, run, null);
		}
		const next = await startRun(connection, config, configKey, state);
		if (connection.closed) {
			await endRun(connection, next, null);
			return;
		}
		connection.run = next;
		void pump(connection, next);
	} else if (
		run &&
		JSON.stringify(state.format) !== JSON.stringify(connection.state.format)
	) {
		run.secondsBefore += run.decoder.seconds;
		run.decoder = createAudioInputDecoder(state.format);
	}
	connection.state = state;
	send(connection, {
		type: "session.updated",
		event_id: eventId(),
		session: renderSession(state),
	});
}

/** Opens the provider run for the session as it is already configured, if it is. */
async function ensureConfiguredRun(
	connection: RealtimeConnection,
): Promise<UpstreamRun | null> {
	const config = realtimeConfigOf(connection.state);
	if (!config) {
		return null;
	}
	const run = await startRun(
		connection,
		config,
		JSON.stringify(config),
		connection.state,
	);
	if (connection.closed) {
		await endRun(connection, run, null);
		return null;
	}
	connection.run = run;
	void pump(connection, run);
	return run;
}

async function handleMessage(
	connection: RealtimeConnection,
	rawMessage: unknown,
): Promise<void> {
	let clientEventId: string | null = null;
	try {
		const event = parseRealtimeClientEvent(realtimeMessageJson(rawMessage));
		clientEventId = event.event_id ?? null;
		if (event.type === "session.update") {
			await updateSession(
				connection,
				applySessionUpdate(connection.state, event.session),
			);
			return;
		}
		// A session configured before the socket opened (a client secret's preset) starts its provider
		// run on first use, as a conversation does; one configured by session.update already has it.
		const run =
			connection.run ??
			(event.type === "input_audio_buffer.append" ||
			event.type === "input_audio_buffer.commit"
				? await ensureConfiguredRun(connection)
				: null);
		if (!run) {
			throw new RealtimeClientEventError(
				event.type === "input_audio_buffer.commit"
					? "Error committing input audio buffer: the buffer is empty."
					: "Set session.audio.input.transcription.model with session.update before sending audio.",
				event.type === "input_audio_buffer.commit"
					? "input_audio_buffer_commit_empty"
					: "session_not_configured",
				event.type === "input_audio_buffer.commit"
					? null
					: "session.audio.input.transcription.model",
				clientEventId,
			);
		}
		if (event.type === "input_audio_buffer.append") {
			if (run.tracker.beforeAudio()) {
				run.session.startUtterance();
			}
			const pcm = run.decoder.push(Buffer.from(event.audio, "base64"));
			if (pcm.byteLength > 0) {
				run.session.appendAudio(pcm);
			}
			return;
		}
		if (event.type === "input_audio_buffer.commit") {
			run.tracker.commit(clientEventId);
			run.session.endUtterance();
			return;
		}
		if (run.tracker.clear()) {
			run.session.endUtterance();
		}
		send(connection, {
			type: "input_audio_buffer.cleared",
			event_id: eventId(),
		});
	} catch (error) {
		if (error instanceof RealtimeClientEventError) {
			send(
				connection,
				realtimeErrorEvent({
					type: "invalid_request_error",
					code: error.code,
					message: error.message,
					param: error.param,
					eventId: error.eventId ?? clientEventId,
				}),
			);
			return;
		}
		sendError(connection, toGatewayError(error), clientEventId);
	}
}

async function closeConnection(connection: RealtimeConnection): Promise<void> {
	if (connection.closed) {
		return;
	}
	connection.closed = true;
	clearTimeout(connection.timer);
	connection.stopCredentialWatch?.();
	unregisterRealtimeSocket(connection.entry);
	// End the provider run first: that aborts whatever a queued client event is waiting on and
	// settles the session's usage. Waiting for the queue first could hang on that very event.
	if (connection.run) {
		await endRun(connection, connection.run, null);
	}
	await connection.queue.catch(() => undefined);
}

/** Builds the socket handlers for a transcription session. Throws when the socket is refused. */
function realtimeTranscriptionSocket(
	c: Context<AppEnv>,
	scopeKey: string,
	preset: RealtimeSessionUpdate | null,
): WSEvents {
	let connection: RealtimeConnection;
	const entry: RealtimeSocketEntry = {
		scopeKey,
		socket: null,
		busy: () => connection.run !== null,
		close: () => closeConnection(connection),
	};
	assertRealtimeSocketCapacity(scopeKey);
	connection = {
		c,
		entry,
		state: preset
			? applySessionUpdate(newRealtimeSessionState(), preset)
			: newRealtimeSessionState(),
		queue: Promise.resolve(),
		queued: 0,
		queuedBytes: 0,
		run: null,
		lastItemId: null,
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
				event_id: eventId(),
				session: renderSession(connection.state),
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

const secretSessionSchema = z.discriminatedUnion("type", [
	realtimeConversationSessionSchema,
	realtimeTranscriptionSessionSchema,
]);

/** The session a client secret was minted with (validated then; parsed again for its types). */
function parseSecretSession(
	session: Record<string, unknown> | null,
): z.infer<typeof secretSessionSchema> | null {
	if (!session) {
		return null;
	}
	const parsed = secretSessionSchema.safeParse(session);
	return parsed.success ? parsed.data : null;
}

export const realtimeWebSocketHandler = upgradeWebSocket(
	(c) => {
		assertWebSocketUpgrade(c);
		const auth = getAuth(c);
		const scopeKey = auth.type === "virtual" ? auth.key.id : "master";
		// A client secret's session applies unless the URL says otherwise, as with OpenAI.
		const secret = parseSecretSession(
			auth.type === "session" ? null : (auth.realtimeSecret?.session ?? null),
		);
		const intent =
			c.req.query("intent") ??
			(secret?.type === "transcription" ? "transcription" : undefined);
		const model =
			c.req.query("model") ??
			(secret?.type === "realtime" ? secret.model : undefined);
		if (intent === "transcription") {
			if (model !== undefined) {
				const message =
					"Transcription sessions take their model from session.update, not the URL.";
				throw new GatewayError({
					class: "bad_request",
					code: "unsupported_parameter",
					message,
					publicMessage: message,
					param: "model",
				});
			}
			return realtimeTranscriptionSocket(
				c,
				scopeKey,
				secret?.type === "transcription" ? secret : null,
			);
		}
		if ((intent !== undefined && intent !== "realtime") || !model) {
			const message =
				intent !== undefined && intent !== "realtime"
					? `Unknown intent '${intent}': use 'realtime' or 'transcription'.`
					: "Connect with ?model=<model> for a realtime conversation, or ?intent=transcription.";
			throw new GatewayError({
				class: "bad_request",
				code:
					intent === undefined ? "missing_required_parameter" : "invalid_value",
				message,
				publicMessage: message,
				param:
					intent !== undefined && intent !== "realtime" ? "intent" : "model",
			});
		}
		return realtimeConversationSocket(
			c,
			scopeKey,
			model,
			secret?.type === "realtime" ? { ...secret, model: undefined } : null,
		);
	},
	{
		onError(error) {
			throw error;
		},
	},
);
