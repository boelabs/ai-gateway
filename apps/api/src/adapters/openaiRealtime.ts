import { upstreamWebSocket } from "#gateway/instrumentedTransport.ts";
import { EventQueue, closeStatus, rawText } from "./google/live.ts";
import { abortGatewayError } from "#gateway/abortReason.ts";
import { createPcmResampler } from "#audio/pcm.ts";
import { GatewayError } from "#core/errors.ts";

import type {
	CanonicalRealtimeTranscriptionConfig,
	CanonicalRealtimeTranscriptionEvent,
	CanonicalRealtimeConversationConfig,
	CanonicalRealtimeConversationEvent,
	RealtimeTranscriptionProfile,
	RealtimeFunctionCall,
	RealtimeUsage,
	RealtimeTurn,
} from "#core/realtime.ts";

import type {
	RealtimeTranscriptionHandler,
	RealtimeTranscriptionSession,
	RealtimeConversationHandler,
	RealtimeConversationSession,
	RealtimeTranslationSession,
	RealtimeTranslationHandler,
	AdapterContext,
} from "./types.ts";

import {
	type CanonicalRealtimeTranslationConfig,
	type CanonicalRealtimeTranslationEvent,
	type RealtimeTranslationProfile,
	TRANSLATION_AUDIO_RATE,
} from "#core/realtimeTranslation.ts";

import {
	realtimeTranscriptionProfileFor,
	realtimeTranslationProfileFor,
} from "#catalog/types.ts";

/**
 * OpenAI's Realtime API (`wss://…/v1/realtime?model=`) as a realtime conversation upstream.
 *
 * The public contract is the same API, but sessions still go through the canonical form so routing,
 * validation, logging and failover treat every provider alike. OpenAI takes audio at 24 kHz only,
 * so canonical 16 kHz input is resampled; its output is already 24 kHz PCM. Unlike Gemini, OpenAI
 * applies `session.update` live, so a configuration change needs no new connection.
 */

/** OpenAI accepts audio at this rate only. */
const OPENAI_AUDIO_RATE = 24_000;
/** Audio is sent in 100 ms chunks. */
const CHUNK_BYTES = (OPENAI_AUDIO_RATE / 10) * 2;
/** The transcription model used when the client asks for transcripts without naming one. */
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-transcribe";

export interface OpenAIRealtimeDeps {
	label: string;
	resolveConnection: (ctx: AdapterContext) => {
		url: string;
		headers: Record<string, string>;
	};
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

/** `https://api.openai.com/v1` -> `wss://api.openai.com/v1/realtime?model=…`. */
export function openAIRealtimeUrl(base: string, model: string): string {
	const url = new URL(base);
	url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	url.pathname = `${url.pathname.replace(/\/+$/u, "")}/realtime`;
	url.search = new URLSearchParams({ model }).toString();
	url.hash = "";
	return url.toString();
}

function turnDetection(
	config: CanonicalRealtimeConversationConfig,
): Record<string, unknown> | null {
	const { vad } = config;
	if (!vad) {
		return null;
	}
	const common = {
		create_response: vad.createResponse,
		interrupt_response: vad.interruptResponse,
	};
	if (vad.type === "semantic_vad") {
		return {
			type: "semantic_vad",
			...(vad.eagerness === undefined ? {} : { eagerness: vad.eagerness }),
			...common,
		};
	}
	return {
		type: "server_vad",
		...(vad.threshold === undefined ? {} : { threshold: vad.threshold }),
		...(vad.prefixPaddingMs === undefined
			? {}
			: { prefix_padding_ms: vad.prefixPaddingMs }),
		...(vad.silenceDurationMs === undefined
			? {}
			: { silence_duration_ms: vad.silenceDurationMs }),
		...(vad.idleTimeoutMs === undefined
			? {}
			: { idle_timeout_ms: vad.idleTimeoutMs }),
		...common,
	};
}

/** One hint goes as `language`; several as `languages` (gpt-transcribe and later). */
function languageHints(
	languages: string[] | undefined,
): Record<string, unknown> {
	if (!languages || languages.length === 0) {
		return {};
	}
	const [language] = languages;
	return languages.length === 1 ? { language } : { languages };
}

/** The canonical configuration as an OpenAI `session.update`. */
export function openAIRealtimeSession(
	config: CanonicalRealtimeConversationConfig,
): Record<string, unknown> {
	const pcm = { type: "audio/pcm", rate: OPENAI_AUDIO_RATE };
	const transcription = config.inputTranscription;
	return {
		type: "realtime",
		instructions: config.instructions ?? "",
		output_modalities: [config.outputModality],
		audio: {
			input: {
				format: pcm,
				turn_detection: turnDetection(config),
				transcription: transcription
					? {
							model: transcription.model ?? DEFAULT_TRANSCRIPTION_MODEL,
							...languageHints(transcription.languages),
							...(transcription.keywords?.length
								? { keywords: transcription.keywords }
								: {}),
						}
					: null,
			},
			output: {
				format: pcm,
				...(config.voice === undefined ? {} : { voice: config.voice }),
				...(config.speed === undefined ? {} : { speed: config.speed }),
			},
		},
		tools: config.tools.map((tool) => ({
			type: "function",
			name: tool.name,
			...(tool.description === undefined
				? {}
				: { description: tool.description }),
			...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
		})),
		tool_choice: config.toolChoice,
		max_output_tokens: config.maxOutputTokens ?? "inf",
		...(config.reasoningEffort
			? { reasoning: { effort: config.reasoningEffort } }
			: {}),
		truncation: config.truncation,
	};
}

/** OpenAI realtime usage -> canonical realtime usage. */
export function openAIRealtimeUsage(raw: unknown): RealtimeUsage | undefined {
	const usage = record(raw);
	if (!usage) {
		return undefined;
	}
	const input = count(usage.input_tokens) ?? 0;
	const output = count(usage.output_tokens) ?? 0;
	if (input === 0 && output === 0) {
		return undefined;
	}
	const inputDetails = record(usage.input_token_details);
	const outputDetails = record(usage.output_token_details);
	const details = {
		textTokens: count(inputDetails?.text_tokens),
		audioTokens: count(inputDetails?.audio_tokens),
		imageTokens: count(inputDetails?.image_tokens),
		cachedTokens: count(inputDetails?.cached_tokens),
		outputTextTokens: count(outputDetails?.text_tokens),
		outputAudioTokens: count(outputDetails?.audio_tokens),
	};
	return {
		inputTokens: input,
		outputTokens: output,
		totalTokens: input + output,
		...Object.fromEntries(
			Object.entries(details).filter(([, value]) => value !== undefined),
		),
	};
}

/** Canonical turns as OpenAI conversation items. Audio parts go at 24 kHz. */
export function openAIRealtimeItems(
	turns: RealtimeTurn[],
): Record<string, unknown>[] {
	const toRate = createPcmResampler(OPENAI_AUDIO_RATE);
	return turns.map((turn) => ({
		type: "message",
		role: turn.role === "model" ? "assistant" : "user",
		content: turn.parts.map((part) => {
			if (part.type === "text") {
				return {
					type: turn.role === "model" ? "output_text" : "input_text",
					text: part.text,
				};
			}
			if (part.type === "image") {
				return {
					type: "input_image",
					image_url: `data:${part.mimeType};base64,${part.data}`,
				};
			}
			return {
				type: "input_audio",
				audio: toRate(part.pcm).toString("base64"),
			};
		}),
	}));
}

/** Per response: the calls collected until `response.done`, so they leave as one batch. */
interface ResponseState {
	calls: RealtimeFunctionCall[];
}

/**
 * One OpenAI server event -> canonical events. `transcripts` tracks, per user item, whether
 * deltas arrived (a `completed` without them carries the whole transcript).
 */
export function parseOpenAIRealtimeEvent(
	raw: unknown,
	state: { response: ResponseState; transcripts: Map<string, boolean> },
): CanonicalRealtimeConversationEvent[] {
	const event = record(raw) ?? {};
	switch (event.type) {
		case "input_audio_buffer.speech_started":
			return [{ kind: "speech_started" }];
		case "input_audio_buffer.speech_stopped":
			return [{ kind: "speech_stopped" }];
		case "conversation.item.input_audio_transcription.delta": {
			const delta = typeof event.delta === "string" ? event.delta : "";
			state.transcripts.set(String(event.item_id), true);
			return delta ? [{ kind: "input_transcript", text: delta }] : [];
		}
		case "conversation.item.input_audio_transcription.completed": {
			const id = String(event.item_id);
			const streamed = state.transcripts.get(id) === true;
			state.transcripts.delete(id);
			const transcript =
				typeof event.transcript === "string" ? event.transcript : "";
			return !streamed && transcript
				? [{ kind: "input_transcript", text: transcript }]
				: [];
		}
		case "response.output_audio.delta":
			return typeof event.delta === "string"
				? [{ kind: "output_audio", pcm: Buffer.from(event.delta, "base64") }]
				: [];
		case "response.output_audio_transcript.delta":
			return typeof event.delta === "string" && event.delta
				? [{ kind: "output_transcript", text: event.delta }]
				: [];
		case "response.output_text.delta":
			return typeof event.delta === "string" && event.delta
				? [{ kind: "output_text", text: event.delta }]
				: [];
		case "response.function_call_arguments.done":
			state.response.calls.push({
				id: String(event.call_id ?? ""),
				name: typeof event.name === "string" ? event.name : "",
				arguments: typeof event.arguments === "string" ? event.arguments : "{}",
			});
			return [];
		case "response.done": {
			const response = record(event.response) ?? {};
			const details = record(response.status_details);
			const events: CanonicalRealtimeConversationEvent[] = [];
			const usage = openAIRealtimeUsage(response.usage);
			if (usage) {
				events.push({ kind: "usage", usage });
			}
			if (state.response.calls.length > 0) {
				events.push({ kind: "function_calls", calls: state.response.calls });
				state.response.calls = [];
			}
			if (
				response.status === "cancelled" &&
				details?.reason === "turn_detected"
			) {
				events.push({ kind: "interrupted" });
			}
			events.push({ kind: "turn_complete" });
			return events;
		}
		case "error": {
			const error = record(event.error);
			return [
				{
					kind: "provider_error",
					code: typeof error?.code === "string" ? error.code : null,
				},
			];
		}
		default:
			return [];
	}
}

/** The open upstream socket, configured and ready for audio. */
interface OpenAIRealtimeConnection {
	send: (event: Record<string, unknown>) => void;
	/** Applies a `session.update`; resolves on `session.updated`, rejects on the error it caused. */
	update: (session: Record<string, unknown>) => Promise<void>;
	/** Closes the socket on purpose: pending updates are rejected, no failure is reported. */
	close: () => void;
	readonly closed: boolean;
}

/** Transcription sessions may still answer with the older `transcription_session.*` names. */
const SESSION_CREATED = new Set([
	"session.created",
	"transcription_session.created",
]);
const SESSION_UPDATED = new Set([
	"session.updated",
	"transcription_session.updated",
]);

/**
 * Opens an OpenAI Realtime socket and applies the first `session.update` once the provider created
 * the session; resolves when that configuration is accepted. Every other server event goes to
 * `onEvent`. A socket that fails afterwards is reported once to `onFail`, as a GatewayError.
 */
async function connectOpenAIRealtime(options: {
	ctx: AdapterContext;
	deps: OpenAIRealtimeDeps;
	url: string;
	session: Record<string, unknown>;
	onEvent: (raw: unknown) => void;
	onFail: (error: unknown) => void;
}): Promise<OpenAIRealtimeConnection> {
	const { ctx, deps, url, onEvent, onFail } = options;
	const socket = upstreamWebSocket(ctx, url, {
		headers: deps.resolveConnection(ctx).headers,
	});
	let closed = false;
	/** `session.update`s waiting for their `session.updated` (or an error). */
	const updates: Array<{
		resolve: () => void;
		reject: (error: unknown) => void;
	}> = [];
	const send = (event: Record<string, unknown>) => {
		if (!closed && socket.readyState === socket.OPEN) {
			socket.send(JSON.stringify(event));
		}
	};
	const fail = (error: unknown) => {
		if (closed) {
			return;
		}
		closed = true;
		for (const pending of updates.splice(0)) {
			pending.reject(error);
		}
		onFail(error);
	};
	const update = (session: Record<string, unknown>) =>
		new Promise<void>((resolve, reject) => {
			updates.push({ resolve, reject });
			send({ type: "session.update", session });
		});

	await new Promise<void>((resolve, reject) => {
		let ready = false;
		const failOrReject = (error: unknown) => {
			if (ready) {
				fail(error);
			} else {
				reject(error);
			}
		};
		socket.on("message", (data) => {
			let raw: unknown;
			try {
				raw = JSON.parse(rawText(data));
			} catch (cause) {
				failOrReject(
					new GatewayError({
						class: "server",
						code: "upstream_protocol_error",
						message: `${deps.label} realtime emitted a message that is not JSON`,
						cause,
					}),
				);
				return;
			}
			const event = record(raw) ?? {};
			const type = String(event.type);
			if (SESSION_CREATED.has(type) && !ready) {
				update(options.session).then(() => {
					ready = true;
					resolve();
				}, reject);
				return;
			}
			if (SESSION_UPDATED.has(type)) {
				updates.shift()?.resolve();
				return;
			}
			if (type === "error" && updates.length > 0) {
				// A refused session.update: the configuration was not applied.
				const error = deps.mapError(
					{ status: 400, body: { error: event.error } },
					ctx,
				);
				updates.shift()?.reject(error);
				return;
			}
			onEvent(raw);
		});
		socket.on("error", (error) => {
			if (!ready) {
				reject(deps.mapError(error, ctx));
			}
		});
		socket.on("unexpected-response", (_request, response) => {
			reject(
				deps.mapError(
					{
						status: response.statusCode ?? 502,
						body: { error: { message: response.statusMessage } },
					},
					ctx,
				),
			);
		});
		socket.on("close", (code, reasonBuffer) => {
			if (ctx.signal?.aborted) {
				failOrReject(abortGatewayError(ctx.signal));
				return;
			}
			if (closed) {
				return;
			}
			const reason = reasonBuffer.toString();
			failOrReject(
				deps.mapError(
					{
						status: closeStatus(code, reason),
						body: {
							error: {
								code,
								message:
									reason || `${deps.label} realtime closed with code ${code}`,
							},
						},
					},
					ctx,
				),
			);
		});
	});
	ctx.watchdog?.headers();
	ctx.watchdog?.complete();

	return {
		send,
		update(session) {
			if (closed) {
				return Promise.reject(
					new GatewayError({
						class: "server",
						message: `${deps.label} realtime session is closed`,
					}),
				);
			}
			return update(session);
		},
		close() {
			if (closed) {
				return;
			}
			closed = true;
			for (const pending of updates.splice(0)) {
				pending.reject(
					new GatewayError({
						class: "server",
						message: `${deps.label} realtime session closed`,
					}),
				);
			}
			socket.close(1000);
		},
		get closed() {
			return closed;
		},
	};
}

/** Canonical 16 kHz input, sent as 24 kHz `input_audio_buffer.append`s of about 100 ms. */
function audioSender(connection: OpenAIRealtimeConnection) {
	const toRate = createPcmResampler(OPENAI_AUDIO_RATE);
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const flush = () => {
		if (pendingBytes === 0) {
			return;
		}
		const audio = Buffer.concat(pending);
		pending = [];
		pendingBytes = 0;
		connection.send({
			type: "input_audio_buffer.append",
			audio: audio.toString("base64"),
		});
	};
	return {
		append(pcm: Buffer) {
			if (connection.closed) {
				return;
			}
			const resampled = toRate(pcm);
			pending.push(resampled);
			pendingBytes += resampled.byteLength;
			if (pendingBytes >= CHUNK_BYTES) {
				flush();
			}
		},
		flush,
	};
}

export function makeOpenAIRealtimeConversationHandler(
	deps: OpenAIRealtimeDeps,
): RealtimeConversationHandler {
	return {
		async connect(initialConfig, ctx): Promise<RealtimeConversationSession> {
			const queue = new EventQueue<CanonicalRealtimeConversationEvent>();
			const parseState = {
				response: { calls: [] } as ResponseState,
				transcripts: new Map<string, boolean>(),
			};
			const connection = await connectOpenAIRealtime({
				ctx,
				deps,
				url: openAIRealtimeUrl(
					deps.resolveConnection(ctx).url,
					ctx.upstreamModel,
				),
				session: openAIRealtimeSession(initialConfig),
				onEvent(raw) {
					for (const canonical of parseOpenAIRealtimeEvent(raw, parseState)) {
						queue.push(canonical);
					}
				},
				onFail: (error) => queue.fail(error),
			});
			const audio = audioSender(connection);
			const { send } = connection;

			return {
				appendAudio: audio.append,
				startActivity() {
					// Manual turns are the session's `turn_detection: null`; the turn ends on commit.
				},
				endActivity() {
					audio.flush();
					send({ type: "input_audio_buffer.commit" });
					send({ type: "response.create" });
				},
				flushAudio() {
					audio.flush();
					send({ type: "input_audio_buffer.commit" });
				},
				sendTurns(turns, complete) {
					audio.flush();
					for (const item of openAIRealtimeItems(turns)) {
						send({ type: "conversation.item.create", item });
					}
					if (complete) {
						send({ type: "response.create" });
					}
				},
				sendFunctionResults(results) {
					for (const result of results) {
						send({
							type: "conversation.item.create",
							item: {
								type: "function_call_output",
								call_id: result.id,
								output: result.output,
							},
						});
					}
					send({ type: "response.create" });
				},
				cancelResponse() {
					send({ type: "response.cancel" });
				},
				// OpenAI applies session.update live: same connection, same conversation.
				reconfigure: (next) => connection.update(openAIRealtimeSession(next)),
				events: queue.iterate(),
				close() {
					if (connection.closed) {
						return;
					}
					connection.close();
					queue.end();
				},
			};
		},
	};
}

/* ------------------------------------------------------------------ transcription */

/** `https://api.openai.com/v1` -> `wss://api.openai.com/v1/realtime?intent=transcription`. */
export function openAIRealtimeTranscriptionUrl(base: string): string {
	const url = new URL(openAIRealtimeUrl(base, "unused"));
	url.search = new URLSearchParams({ intent: "transcription" }).toString();
	return url.toString();
}

/**
 * The canonical configuration as a transcription `session.update`. A model that takes several
 * language hints gets them as `languages`, a single one included (gpt-live-transcribe rejects the
 * singular `language`); vocabulary goes only to a model that declares it.
 */
export function openAITranscriptionSession(
	config: CanonicalRealtimeTranscriptionConfig,
	model: string,
	profile: RealtimeTranscriptionProfile | undefined,
): Record<string, unknown> {
	const languages =
		config.languages ?? (config.language ? [config.language] : undefined);
	let hints: Record<string, unknown> = {};
	if (languages?.length) {
		hints = profile?.supportsLanguageHints
			? { languages }
			: { language: languages[0] };
	}
	return {
		type: "transcription",
		audio: {
			input: {
				format: { type: "audio/pcm", rate: OPENAI_AUDIO_RATE },
				transcription: {
					model,
					...hints,
					...(config.keywords?.length && profile?.supportsKeywords
						? { keywords: config.keywords }
						: {}),
				},
				turn_detection:
					config.turnDetection === "server_vad" ? { type: "server_vad" } : null,
			},
		},
	};
}

/**
 * Transcripts in the order their utterances were committed. OpenAI does not guarantee that order
 * across turns, but the canonical stream has one open utterance at a time: text for a later item
 * waits until every earlier one is final.
 */
export class OpenAITranscriptOrder {
	private readonly order: string[] = [];
	private readonly text = new Map<string, string>();
	private readonly done = new Map<string, string>();

	/** The open utterance: the earliest one not yet final. */
	private get head(): string | undefined {
		const [first] = this.order;
		return first;
	}

	private track(id: string): void {
		if (!this.order.includes(id)) {
			this.order.push(id);
		}
	}

	committed(id: string): void {
		this.track(id);
	}

	delta(id: string, delta: string): CanonicalRealtimeTranscriptionEvent[] {
		this.track(id);
		const text = (this.text.get(id) ?? "") + delta;
		this.text.set(id, text);
		return this.head === id && delta ? [{ kind: "interim", text }] : [];
	}

	completed(
		id: string,
		transcript: string,
	): CanonicalRealtimeTranscriptionEvent[] {
		this.track(id);
		this.done.set(id, transcript);
		const events: CanonicalRealtimeTranscriptionEvent[] = [];
		for (
			let { head } = this;
			head !== undefined && this.done.has(head);
			{ head } = this
		) {
			events.push({ kind: "final", text: this.done.get(head) ?? "" });
			this.order.shift();
			this.text.delete(head);
			this.done.delete(head);
		}
		// The next utterance becomes the open one: show what it has streamed so far.
		const { head } = this;
		const text = head === undefined ? undefined : this.text.get(head);
		if (events.length > 0 && text) {
			events.push({ kind: "interim", text });
		}
		return events;
	}
}

/** Token usage a transcription event carries; duration usage is measured by the gateway itself. */
function transcriptionUsage(raw: unknown): RealtimeUsage | undefined {
	const usage = record(raw);
	return usage?.type === "tokens" ? openAIRealtimeUsage(usage) : undefined;
}

/**
 * OpenAI's Realtime API in transcription mode (`?intent=transcription`, a `transcription` session)
 * as a realtime transcription upstream: gpt-live-transcribe and the models a transcription session
 * accepts. Canonical 16 kHz audio is resampled to the 24 kHz OpenAI takes.
 */
export function makeOpenAIRealtimeTranscriptionHandler(
	deps: OpenAIRealtimeDeps,
): RealtimeTranscriptionHandler {
	return {
		async connect(config, ctx): Promise<RealtimeTranscriptionSession> {
			const queue = new EventQueue<CanonicalRealtimeTranscriptionEvent>();
			const transcripts = new OpenAITranscriptOrder();
			const failed = (event: Record<string, unknown>) => {
				const error = record(event.error);
				return new GatewayError({
					class: "server",
					code: "upstream_error",
					message: `${deps.label} realtime transcription failed: ${
						typeof error?.message === "string" ? error.message : "unknown error"
					}`,
					failureKind: "transient",
				});
			};
			let connection: OpenAIRealtimeConnection | undefined;
			const onEvent = (raw: unknown) => {
				const event = record(raw) ?? {};
				const id = String(event.item_id ?? "");
				switch (event.type) {
					case "input_audio_buffer.committed":
						transcripts.committed(id);
						return;
					case "conversation.item.input_audio_transcription.delta":
						for (const canonical of transcripts.delta(
							id,
							typeof event.delta === "string" ? event.delta : "",
						)) {
							queue.push(canonical);
						}
						return;
					case "conversation.item.input_audio_transcription.completed": {
						const usage = transcriptionUsage(event.usage);
						if (usage) {
							queue.push({ kind: "usage", usage });
						}
						for (const canonical of transcripts.completed(
							id,
							typeof event.transcript === "string" ? event.transcript : "",
						)) {
							queue.push(canonical);
						}
						return;
					}
					case "conversation.item.input_audio_transcription.failed":
					case "error":
						connection?.close();
						queue.fail(
							event.type === "error"
								? deps.mapError(
										{ status: 400, body: { error: event.error } },
										ctx,
									)
								: failed(event),
						);
						return;
					default:
						return;
				}
			};
			connection = await connectOpenAIRealtime({
				ctx,
				deps,
				url: openAIRealtimeTranscriptionUrl(deps.resolveConnection(ctx).url),
				session: openAITranscriptionSession(
					config,
					ctx.upstreamModel,
					realtimeTranscriptionProfileFor(ctx.meta),
				),
				onEvent,
				onFail: (error) => queue.fail(error),
			});
			const audio = audioSender(connection);
			const open = connection;

			return {
				appendAudio: audio.append,
				startUtterance() {
					// Manual turns are the session's `turn_detection: null`; the turn ends on commit.
				},
				endUtterance() {
					audio.flush();
					open.send({ type: "input_audio_buffer.commit" });
				},
				events: queue.iterate(),
				close() {
					if (open.closed) {
						return;
					}
					open.close();
					queue.end();
				},
			};
		},
	};
}

/* ------------------------------------------------------------------ translation */

/** The source transcript model used when the client enables one without naming it. */
const DEFAULT_TRANSLATION_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
/** Translation audio is sent in the 200 ms frames the engine consumes. */
const TRANSLATION_CHUNK_BYTES = (TRANSLATION_AUDIO_RATE / 5) * 2;
/** How long `finish` waits for `session.closed` before giving up on the remaining output. */
const TRANSLATION_FINISH_MS = 10_000;

/** `https://api.openai.com/v1` -> `wss://api.openai.com/v1/realtime/translations?model=…`. */
export function openAIRealtimeTranslationUrl(
	base: string,
	model: string,
): string {
	const url = new URL(openAIRealtimeUrl(base, model));
	url.pathname = `${url.pathname}/translations`;
	return url.toString();
}

/** The canonical configuration as a translation `session.update`. */
export function openAITranslationSession(
	config: CanonicalRealtimeTranslationConfig,
	profile: RealtimeTranslationProfile | undefined,
): Record<string, unknown> {
	return {
		audio: {
			input: {
				transcription: config.inputTranscription
					? {
							model:
								config.inputTranscription.model ??
								DEFAULT_TRANSLATION_TRANSCRIPTION_MODEL,
						}
					: null,
				...(profile?.supportsNoiseReduction
					? { noise_reduction: config.noiseReduction }
					: {}),
			},
			...(config.language ? { output: { language: config.language } } : {}),
		},
	};
}

function elapsedMs(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * OpenAI's realtime translation API (`/v1/realtime/translations`, gpt-realtime-translate) as a
 * translation upstream, on OpenAI or Azure's v1 surface. Audio is already at the 24 kHz it takes.
 */
export function makeOpenAIRealtimeTranslationHandler(
	deps: OpenAIRealtimeDeps,
): RealtimeTranslationHandler {
	return {
		async connect(config, ctx): Promise<RealtimeTranslationSession> {
			const queue = new EventQueue<CanonicalRealtimeTranslationEvent>();
			const profile = realtimeTranslationProfileFor(ctx.meta);
			let finished: (() => void) | null = null;
			let connection: OpenAIRealtimeConnection | undefined;
			const onEvent = (raw: unknown) => {
				const event = record(raw) ?? {};
				const at = elapsedMs(event.elapsed_ms);
				const delta = typeof event.delta === "string" ? event.delta : "";
				switch (event.type) {
					case "session.input_transcript.delta":
						if (delta) {
							queue.push({
								kind: "input_transcript",
								text: delta,
								elapsedMs: at,
							});
						}
						return;
					case "session.output_transcript.delta":
						if (delta) {
							queue.push({
								kind: "output_transcript",
								text: delta,
								elapsedMs: at,
							});
						}
						return;
					case "session.output_audio.delta":
						if (delta) {
							queue.push({
								kind: "output_audio",
								pcm: Buffer.from(delta, "base64"),
								elapsedMs: at,
							});
						}
						return;
					case "error": {
						const error = record(event.error);
						queue.push({
							kind: "provider_error",
							code: typeof error?.code === "string" ? error.code : null,
						});
						return;
					}
					case "session.closed":
						// The provider drained its output; close before it hangs up on us.
						connection?.close();
						queue.end();
						finished?.();
						return;
					default:
						return;
				}
			};
			connection = await connectOpenAIRealtime({
				ctx,
				deps,
				url: openAIRealtimeTranslationUrl(
					deps.resolveConnection(ctx).url,
					ctx.upstreamModel,
				),
				session: openAITranslationSession(config, profile),
				onEvent,
				onFail: (error) => queue.fail(error),
			});
			const open = connection;
			let pending: Buffer[] = [];
			let pendingBytes = 0;
			const flush = () => {
				if (pendingBytes === 0) {
					return;
				}
				const audio = Buffer.concat(pending);
				pending = [];
				pendingBytes = 0;
				open.send({
					type: "session.input_audio_buffer.append",
					audio: audio.toString("base64"),
				});
			};

			return {
				appendAudio(pcm) {
					if (open.closed) {
						return;
					}
					pending.push(pcm);
					pendingBytes += pcm.byteLength;
					if (pendingBytes >= TRANSLATION_CHUNK_BYTES) {
						flush();
					}
				},
				reconfigure: (next) =>
					open.update(openAITranslationSession(next, profile)),
				finish() {
					if (open.closed) {
						return Promise.resolve();
					}
					flush();
					open.send({ type: "session.close" });
					return new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, TRANSLATION_FINISH_MS);
						timer.unref?.();
						finished = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				},
				events: queue.iterate(),
				close() {
					if (open.closed) {
						return;
					}
					open.close();
					queue.end();
				},
			};
		},
	};
}
