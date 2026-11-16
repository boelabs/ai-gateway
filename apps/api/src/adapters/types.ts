import type { UpstreamTransport, AdapterTransports } from "#core/transport.ts";
import type { AttemptWatchdog } from "#gateway/attemptWatchdog.ts";
import type { ParameterSupportMap } from "#catalog/parameters.ts";
import type { ReasoningControlKind } from "#core/reasoning.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import type { ServiceMode } from "#core/serviceMode.ts";
import type { GatewayError } from "#core/errors.ts";
import type { CallType } from "#core/callType.ts";

import type {
	CanonicalRealtimeTranscriptionConfig,
	CanonicalRealtimeConversationConfig,
	CanonicalRealtimeTranscriptionEvent,
	CanonicalRealtimeConversationEvent,
	RealtimeFunctionResult,
	RealtimeTurn,
} from "#core/realtime.ts";

import type {
	CanonicalTranscriptionStreamEvent,
	CanonicalTranscriptionResponse,
	CanonicalTranscriptionRequest,
} from "#core/audio.ts";

import type {
	CanonicalVideoProviderJob,
	CanonicalVideoRequest,
	CanonicalVideoContent,
	VideoAssetVariant,
} from "#core/videos.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalChatRequest,
} from "#core/canonical.ts";

import type {
	CanonicalImageStreamEvent,
	CanonicalImageResponse,
	CanonicalImageRequest,
} from "#core/images.ts";

import type {
	CanonicalEmbeddingsResponse,
	CanonicalEmbeddingsRequest,
} from "#core/embeddings.ts";

import type {
	CanonicalDecisionResponse,
	CanonicalDecisionRequest,
} from "#core/decisions.ts";

import type {
	CanonicalRerankResponse,
	CanonicalRerankRequest,
} from "#core/rerank.ts";
import type {
	CanonicalSpeechResponse,
	CanonicalSpeechRequest,
} from "#core/speech.ts";

/** Upstream error the executor passes to `mapError` when the response is not 2xx. */
export interface UpstreamError {
	status: number;
	/** Already-parsed error body (JSON) or raw text. */
	body: unknown;
	/** Selected response headers that affect retry behavior. */
	headers?: Record<string, string>;
}

/** HTTP request built toward the upstream. The executor runs it with fetch. */
type UpstreamBody = NonNullable<RequestInit["body"]>;

export type ContentInputSource = "provider_file_id" | "url" | "data_url";

export interface ContentPartInputSupport {
	/** Source forms the transport can receive without gateway-side materialization. */
	sources: readonly ContentInputSource[];
	/** Optional MIME allowlist. Supports exact values and type wildcards such as text/*. */
	mimeTypes?: readonly string[];
	/** Inline byte limit enforced before the adapter serializes the request. */
	maxBytes?: number;
}

/**
 * Multimodal input capabilities for one upstream transport. New canonical content kinds belong here
 * instead of in provider-specific routing branches.
 */
export interface ContentInputTransportSupport {
	audio?: ContentPartInputSupport;
	file?: ContentPartInputSupport;
	image?: ContentPartInputSupport;
	video?: ContentPartInputSupport;
}

export interface UpstreamHttpRequest<TBody extends UpstreamBody = string> {
	method: string;
	url: string;
	headers: Record<string, string>;
	/** Serialized body: a JSON string or FormData on binary endpoints. */
	body?: TBody;
}

/** Context the router/executor passes to the adapter for a specific call. */
export interface AdapterContext {
	/** The model at the upstream (upstream_model of the chosen deployment). */
	upstreamModel: string;
	/** Already-decrypted credentials (api key, base url, org id, headers...). */
	credentials: Record<string, unknown>;
	/** Effective model metadata (catalog + override): capabilities, pricing, limits, reasoning. */
	meta: ResolvedModelMetadata;
	/** Upstream transport resolved for this call. */
	transport: UpstreamTransport;
	requestId: string;
	operationId?: string;
	/** To cancel/timeout the upstream call. */
	signal?: AbortSignal;
	/** The attempt's connection deadlines, fed by the executor and transport; adapters never touch it. */
	watchdog?: AttemptWatchdog;
	/** Mutable private evidence for transport-level observations that do not produce a public frame. */
	diagnostics?: AdapterDiagnostics;
	/** Service mode the client chose with a `model:mode` suffix; only set when the adapter supports it. */
	serviceMode?: ServiceMode;
	/** Private transport timestamps populated by the instrumented executor. */
	timings?: { headersAt?: number };
	/** Byte counters populated only by the instrumented HTTP/WebSocket transport. */
	transportStats?: { upstreamBytes: number };
}

export interface ChatSupportContext {
	upstreamModel: string;
	meta: ResolvedModelMetadata;
	transport: UpstreamTransport;
}

/** Safe, private provider evidence retained for operator diagnostics and never rendered publicly. */
export interface AdapterDiagnostics {
	providerRequestId?: string;
	modelVersion?: string;
	/** The service tier a provider reports it served in a response header (`x-gemini-service-tier`). */
	servedServiceTier?: string;
	originalTerminalReason?: string;
	transportTerminator?:
		| "eof"
		| "done_marker"
		| "semantic_event"
		| "websocket_turn";
	/** Private normalized evidence when a protocol outcome cannot be represented by finishReason alone. */
	terminal?: {
		outcome: "completed" | "incomplete" | "blocked";
		reason:
			| "stop"
			| "length"
			| "tool_calls"
			| "content_filter"
			| "refusal"
			| "other";
	};
	metadata?: Record<string, unknown>;
}

/** An adapter's canonical text handler. */
export interface ChatHandler {
	buildRequest: (
		req: CanonicalChatRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (raw: unknown, ctx: AdapterContext) => CanonicalChatResponse;
	parseStream: (
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	) => AsyncIterable<CanonicalChatStreamChunk>;
	/** Maps an upstream error (non-2xx HTTP, error body, exception) to a GatewayError. */
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

export interface MessageTokenCountRequest {
	canonical: CanonicalChatRequest;
	/** Parsed Anthropic request retained so native counters receive future-compatible input fields. */
	rawBody: Record<string, unknown>;
}

export interface MessageTokenCountResponse {
	inputTokens: number;
}

/** Optional native implementation of Anthropic's Messages token-count endpoint. */
export interface MessageTokenCountHandler {
	buildRequest: (
		req: MessageTokenCountRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
	) => MessageTokenCountResponse;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/**
 * A persistent upstream Responses WebSocket. The gateway still translates every event through the
 * canonical core; this is a transport optimization, never a public-protocol passthrough.
 */
export interface ResponsesWebSocketTurn {
	chunks: AsyncIterable<CanonicalChatStreamChunk>;
	/** Resolves after response.created (or the terminal event when no id was emitted). */
	upstreamResponseId: Promise<string | null>;
}

export interface ResponsesWebSocketSession {
	create: (
		req: CanonicalChatRequest,
		options: {
			previousResponseId?: string;
			generate: boolean;
			signal: AbortSignal;
		},
	) => Promise<ResponsesWebSocketTurn>;
	close: (code?: number, reason?: string) => void;
	readonly closed: boolean;
}

export interface ResponsesWebSocketHandler {
	connect: (ctx: AdapterContext) => Promise<ResponsesWebSocketSession>;
}

export interface ImageHandler {
	buildRequest: (
		req: CanonicalImageRequest,
		ctx: AdapterContext,
	) =>
		| UpstreamHttpRequest<UpstreamBody>
		| Promise<UpstreamHttpRequest<UpstreamBody>>;
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
	) => CanonicalImageResponse | Promise<CanonicalImageResponse>;
	parseStream?: (
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	) => AsyncIterable<CanonicalImageStreamEvent>;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/** An adapter's canonical audio-transcription handler. */
export interface TranscriptionHandler {
	buildRequest: (
		req: CanonicalTranscriptionRequest,
		ctx: AdapterContext,
	) =>
		| UpstreamHttpRequest<UpstreamBody>
		| Promise<UpstreamHttpRequest<UpstreamBody>>;
	/**
	 * `raw` is a JSON object (json/verbose_json) or a raw string (text/srt/vtt). `req` lets an adapter
	 * whose upstream has one response shape render the requested format itself.
	 */
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
		req: CanonicalTranscriptionRequest,
	) => CanonicalTranscriptionResponse;
	parseStream?: (
		stream: ReadableStream<Uint8Array>,
		ctx: AdapterContext,
	) => AsyncIterable<CanonicalTranscriptionStreamEvent>;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/**
 * One live transcription session at the provider. It may span several upstream connections (a
 * provider that caps a connection's length is reconnected behind it), but the caller sees one
 * ordered event stream.
 */
export interface RealtimeTranscriptionSession {
	/** 16-bit little-endian mono PCM at `REALTIME_AUDIO_SAMPLE_RATE`. */
	appendAudio: (pcm: Buffer) => void;
	/** Manual turns: the client started an utterance. */
	startUtterance: () => void;
	/** Ends the open utterance: the client committed it (manual) or flushed it early (VAD). */
	endUtterance: () => void;
	/** Ends when the session closes; throws a GatewayError when the provider fails it. */
	events: AsyncIterable<CanonicalRealtimeTranscriptionEvent>;
	close: () => void;
}

/** An adapter's live-audio transcription handler. */
export interface RealtimeTranscriptionHandler {
	/** Resolves once the provider accepted the session configuration. */
	connect: (
		config: CanonicalRealtimeTranscriptionConfig,
		ctx: AdapterContext,
	) => Promise<RealtimeTranscriptionSession>;
}

/**
 * One live conversation with a provider. Like transcription, a provider that caps a connection is
 * reconnected behind it; here the provider's session resumption keeps the conversation's context.
 */
export interface RealtimeConversationSession {
	/** 16-bit little-endian mono PCM at `REALTIME_AUDIO_SAMPLE_RATE`. */
	appendAudio: (pcm: Buffer) => void;
	/** Manual turns: the user started speaking. */
	startActivity: () => void;
	/** Manual turns: the user is done; the model answers. */
	endActivity: () => void;
	/** VAD turns: the client flushed its audio; the provider should finalize what it heard. */
	flushAudio: () => void;
	/** Appends turns to the conversation; `complete` asks the model to answer now. */
	sendTurns: (turns: RealtimeTurn[], complete: boolean) => void;
	/** Results of the model's function calls; the model continues with them. */
	sendFunctionResults: (results: RealtimeFunctionResult[]) => void;
	/** Stops the reply being generated, for providers that can (otherwise it is only dropped). */
	cancelResponse?: () => void;
	/**
	 * Applies a new configuration (same model). Resolves once the provider accepted it; the
	 * conversation's context survives when the provider can resume sessions.
	 */
	reconfigure: (config: CanonicalRealtimeConversationConfig) => Promise<void>;
	/** Ends when the session closes; throws a GatewayError when the provider fails it. */
	events: AsyncIterable<CanonicalRealtimeConversationEvent>;
	close: () => void;
}

/** An adapter's live conversation handler. */
export interface RealtimeConversationHandler {
	/** Resolves once the provider accepted the session configuration. */
	connect: (
		config: CanonicalRealtimeConversationConfig,
		ctx: AdapterContext,
	) => Promise<RealtimeConversationSession>;
}

/** One server event of a live session: the frame as received, and its parsed form. */
export interface LiveServerFrame {
	text: string;
	event: Record<string, unknown>;
}

/**
 * An open GPT-Live socket at the provider: a primary or fork session (`started` is its
 * `session.started`), or a sideband attach (`started` is null). Frames pass through unchanged.
 */
export interface LiveUpstream {
	started: Record<string, unknown> | null;
	/** Sends a client event as the client wrote it. */
	send: (text: string) => void;
	/** Ends when the provider closes the socket; throws a GatewayError when it fails. */
	frames: AsyncIterable<LiveServerFrame>;
	close: () => void;
}

/**
 * An adapter's GPT-Live handler (`/v1/live/sessions`). The protocol is relayed, not translated:
 * `start` and `create` receive the client's body with `session.model` already set to the upstream
 * model.
 */
export interface LiveSessionHandler {
	/** Opens a session (or a fork of `forkOf`) with `session.start`; resolves on `session.started`. */
	start: (
		start: Record<string, unknown>,
		ctx: AdapterContext,
		forkOf?: string,
	) => Promise<LiveUpstream>;
	/** Opens the sideband socket of a running session. */
	attach: (sessionId: string, ctx: AdapterContext) => Promise<LiveUpstream>;
	/** Creates a WebRTC or SIP session (or forks one): `POST /live/sessions`. Resolves to its JSON. */
	create: (
		body: Record<string, unknown>,
		ctx: AdapterContext,
		forkOf?: string,
	) => Promise<{ status: number; body: Record<string, unknown> }>;
	/** A stored session's recording: `GET /live/sessions/{id}/content`, streamed as is. */
	content: (sessionId: string, ctx: AdapterContext) => Promise<Response>;
}

/** An adapter's canonical embeddings handler. No streaming. */
export interface EmbeddingsHandler {
	buildRequest: (
		req: CanonicalEmbeddingsRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
	) => CanonicalEmbeddingsResponse;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/**
 * An adapter's text-to-speech handler. No streaming: the audio comes back whole, in the format the
 * request resolved to (see `speechFormatFor`).
 */
export interface SpeechHandler {
	buildRequest: (
		req: CanonicalSpeechRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
		req: CanonicalSpeechRequest,
	) => CanonicalSpeechResponse;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/** An adapter's canonical reranking handler. No streaming. */
export interface RerankHandler {
	/** Whether the OpenRouter-shaped `provider` routing object can be honored. */
	supportsProviderRouting?: boolean;
	buildRequest: (
		req: CanonicalRerankRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (raw: unknown, ctx: AdapterContext) => CanonicalRerankResponse;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/**
 * An adapter's canonical decisions handler. No streaming. `parseResponse` receives the request because
 * upstreams that key answers by name are mapped back to the request's question order.
 */
export interface DecisionsHandler {
	buildRequest: (
		req: CanonicalDecisionRequest,
		ctx: AdapterContext,
	) => UpstreamHttpRequest;
	parseResponse: (
		raw: unknown,
		ctx: AdapterContext,
		req: CanonicalDecisionRequest,
	) => CanonicalDecisionResponse;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

export interface VideoJobRef {
	upstreamJobId: string;
	upstreamGenerationId?: string | null;
	upstreamPollingUrl?: string | null;
	providerState?: Record<string, unknown> | null;
}

/** An adapter's async video-generation handler. */
export interface VideoHandler {
	submit: (
		req: CanonicalVideoRequest,
		ctx: AdapterContext,
	) => Promise<CanonicalVideoProviderJob>;
	refresh: (
		job: VideoJobRef,
		ctx: AdapterContext,
	) => Promise<CanonicalVideoProviderJob>;
	download: (
		job: VideoJobRef,
		variant: VideoAssetVariant,
		ctx: AdapterContext,
	) => Promise<CanonicalVideoContent>;
	/** Best-effort upstream delete/cancel. Absent when the provider has no such endpoint. */
	remove?: (job: VideoJobRef, ctx: AdapterContext) => Promise<void>;
	mapError: (err: unknown, ctx: AdapterContext) => GatewayError;
}

/**
 * An adapter implements one or more upstream protocols. It is registered in code.
 *
 * Public endpoints render canonical types per family. Chat feeds Chat, Responses, and Messages;
 * Images has its own binary/event contracts and can travel over OpenAI Images, multimodal
 * chat_completions, or generateContent.
 */
export interface Adapter {
	key: string;
	credentials: {
		required: readonly string[];
	};
	supportedCallTypes: ReadonlySet<CallType>;
	/**
	 * Service modes this adapter can request upstream (`model:fast`, `:flex`, `:priority`). A model
	 * also needs the tier priced in its catalog; anything else is refused before routing.
	 */
	serviceModes?: ReadonlySet<ServiceMode>;
	chat?: ChatHandler;
	/** Rejects requests whose guarantee cannot be honored by the resolved transport. */
	assertChatRequestSupported?: (
		req: CanonicalChatRequest,
		ctx: ChatSupportContext,
	) => void;
	messageTokenCount?: MessageTokenCountHandler;
	/** Optional native persistent /responses WebSocket transport. */
	responsesWebSocket?: ResponsesWebSocketHandler;
	imageGeneration?: ImageHandler;
	imageEdit?: ImageHandler;
	videoGeneration?: VideoHandler;
	audioTranscription?: TranscriptionHandler;
	speech?: SpeechHandler;
	realtimeTranscription?: RealtimeTranscriptionHandler;
	realtimeConversation?: RealtimeConversationHandler;
	liveSession?: LiveSessionHandler;
	embeddings?: EmbeddingsHandler;
	rerank?: RerankHandler;
	decisions?: DecisionsHandler;
	/** Upstream transports per CallType. */
	transports?: Partial<Record<CallType, AdapterTransports>>;
	/** Native multimodal-input support by upstream transport. */
	contentInputs?: Partial<
		Record<UpstreamTransport, ContentInputTransportSupport>
	>;
	/**
	 * Reasoning-control families this adapter can emit to the upstream. Validated at boot against the
	 * catalog: a model with a `reasoning.kind` outside this set fails at startup (it used to fail at
	 * request time). Absent = not validated.
	 */
	reasoningKinds?: ReadonlySet<ReasoningControlKind>;
	/**
	 * What each chat transport does with canonical request parameters it cannot carry, keyed by the
	 * catalog's parameter names (`top_k`, `seed`, ...). An `unsupported` or `ignored` entry makes the
	 * parameter policy drop the field and record it in `droppedParameters` (or reject it, per the
	 * strategy) instead of the adapter losing it silently. A model's catalog entry overrides it.
	 */
	chatParameters?: Partial<Record<UpstreamTransport, ParameterSupportMap>>;
	/**
	 * Checks a deployment's credentials when they are saved (create or patch), so a malformed value
	 * is the operator's error at that moment instead of every request's later. Throws a GatewayError.
	 */
	validateCredentials?: (credentials: Record<string, unknown>) => void;
	/**
	 * Parameters this request makes unsupported on top of the model's declarations, for constraints
	 * that depend on the request itself (Anthropic rejects temperature while thinking is on). The
	 * parameter policy applies them like any other declaration: dropped and recorded, or rejected.
	 */
	chatRequestParameters?: (
		req: CanonicalChatRequest,
		ctx: ChatSupportContext,
	) => ParameterSupportMap | undefined;
}

/** A provider as a self-contained upstream-protocol unit. The JSON catalog is mounted in the central registry. */
export interface ProviderModule {
	adapter: Adapter;
}
