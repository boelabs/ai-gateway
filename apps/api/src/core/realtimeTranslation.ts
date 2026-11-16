import type { RealtimeUsage } from "./realtime.ts";

/**
 * Canonical realtime speech translation: speech in, the same speech in another language out, with
 * no turns. The public contract is OpenAI's `/v1/realtime/translations`; adapters speak their
 * provider's protocol (OpenAI's own, or Gemini Live in translation mode). Audio crosses this boundary
 * as 16-bit little-endian mono PCM at 24 kHz in both directions, the contract's only format.
 */

export const TRANSLATION_AUDIO_RATE = 24_000;

export interface CanonicalRealtimeTranslationConfig {
	model: string;
	/** Target language of the translated speech; absent leaves the provider's default. */
	language?: string;
	/** Transcribe the source speech; `model` is the client's choice, for providers that take one. */
	inputTranscription: { model?: string } | null;
	noiseReduction: {
		type: "near_field" | "far_field";
		strength?: number;
	} | null;
}

export type CanonicalRealtimeTranslationEvent =
	/** More of the source speech's transcript, append-only. */
	| { kind: "input_transcript"; text: string; elapsedMs?: number | null }
	/** More of the translation's transcript, append-only. */
	| { kind: "output_transcript"; text: string; elapsedMs?: number | null }
	/** 24 kHz PCM16 of the translated speech. */
	| { kind: "output_audio"; pcm: Buffer; elapsedMs?: number | null }
	/** The provider refused an event; the session goes on. */
	| { kind: "provider_error"; code: string | null }
	| { kind: "usage"; usage: RealtimeUsage };

/** What a translation model accepts, checked on every `session.update`. */
export interface RealtimeTranslationProfile {
	/** Target languages it translates into. Absent: not validated. */
	languages?: string[];
	/** Can transcribe the source speech. */
	supportsInputTranscription?: boolean;
	/**
	 * The source transcript runs on a separate model the client names (`transcription.model`),
	 * billed on its own: the gateway prices it from that model's catalog entry.
	 */
	separateInputTranscription?: boolean;
	/** Applies `noise_reduction`; otherwise it is accepted and not sent. */
	supportsNoiseReduction?: boolean;
	/** The provider ends a single upstream session after this long; the gateway reconnects. */
	maxUpstreamSessionSeconds?: number;
}
