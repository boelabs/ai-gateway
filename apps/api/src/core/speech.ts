import type { Usage } from "./usage.ts";

/**
 * Audio encodings of the OpenAI `/v1/audio/speech` contract. A model lists the ones its provider can
 * return in its profile; the gateway does not transcode, so any other is refused before routing.
 */
export const SPEECH_RESPONSE_FORMATS = [
	"mp3",
	"opus",
	"aac",
	"flac",
	"wav",
	"pcm",
] as const;
export type SpeechResponseFormat = (typeof SPEECH_RESPONSE_FORMATS)[number];

export const SPEECH_CONTENT_TYPES: Record<SpeechResponseFormat, string> = {
	mp3: "audio/mpeg",
	opus: "audio/opus",
	aac: "audio/aac",
	flac: "audio/flac",
	wav: "audio/wav",
	pcm: "audio/pcm",
};

export interface CanonicalSpeechRequest {
	model: string;
	/** The text to speak. */
	input: string;
	/** A voice name or id, passed to the provider as given (custom voices included). */
	voice: string;
	/** Delivery direction (tone, pace, accent), for models whose profile accepts it. */
	instructions?: string;
	/** Absent: the first format of the model's profile. */
	responseFormat?: SpeechResponseFormat;
	speed?: number;
}

export interface CanonicalSpeechResponse {
	audio: Uint8Array;
	format: SpeechResponseFormat;
	usage?: Usage;
}

/** What a speech model accepts (the client contract), checked before routing. */
export interface SpeechProfile {
	/** Encodings the provider returns, the default first. */
	responseFormats: SpeechResponseFormat[];
	/** Documented prebuilt voices, for discovery. Not enforced: providers also take custom voice ids. */
	voices?: string[];
	/** Accepts `instructions`; otherwise a request carrying them is refused. */
	supportsInstructions?: boolean;
	/** Accepts a `speed` other than 1. */
	supportsSpeed?: boolean;
	/** Longest `input`, in characters. */
	maxInputCharacters?: number;
	/** The provider's output limit in tokens, reserved against budgets before the call. */
	maxOutputTokens?: number;
}

/** The format a request gets: the one it asked for, or the model's default. */
export function speechFormatFor(
	req: Pick<CanonicalSpeechRequest, "responseFormat">,
	profile: Pick<SpeechProfile, "responseFormats">,
): SpeechResponseFormat {
	const [fallback] = profile.responseFormats;
	if (!fallback) {
		throw new TypeError("A speech profile needs at least one response format");
	}
	return req.responseFormat ?? fallback;
}

/** 16-bit little-endian mono PCM wrapped in a canonical 44-byte WAV (RIFF) header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) {
			view.setUint8(offset + i, text.charCodeAt(i));
		}
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, "data");
	view.setUint32(40, pcm.byteLength, true);
	const out = new Uint8Array(44 + pcm.byteLength);
	out.set(new Uint8Array(header), 0);
	out.set(pcm, 44);
	return out;
}

/**
 * The PCM samples of a WAV file and their rate: the payload of its `data` chunk and the rate in its
 * `fmt ` chunk, wherever the chunks sit. Returns `null` for anything that is not a RIFF/WAVE file.
 */
export function readWav(
	wav: Uint8Array,
): { pcm: Uint8Array; sampleRate: number } | null {
	const fourcc = (at: number) =>
		String.fromCharCode(...wav.subarray(at, at + 4));
	if (wav.byteLength < 12 || fourcc(0) !== "RIFF" || fourcc(8) !== "WAVE") {
		return null;
	}
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	let sampleRate: number | undefined;
	let offset = 12;
	while (offset + 8 <= wav.byteLength) {
		const size = view.getUint32(offset + 4, true);
		const chunk = fourcc(offset);
		if (chunk === "fmt " && offset + 16 <= wav.byteLength) {
			sampleRate = view.getUint32(offset + 12, true);
		} else if (chunk === "data" && sampleRate !== undefined) {
			const end = Math.min(offset + 8 + size, wav.byteLength);
			return { pcm: wav.subarray(offset + 8, end), sampleRate };
		}
		offset += 8 + size + (size % 2);
	}
	return null;
}
