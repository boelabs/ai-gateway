/**
 * Upper bounds for the input tokens of binary content, by modality. Base64 is not text: counting its
 * characters as tokens charges a 300 KB image as about 400,000 tokens, which locks a budget for a
 * request that costs a few thousand.
 *
 * - Images: providers resize and tile them; Anthropic documents about 1,600 tokens for a full-size
 *   image. 2,500 leaves room for providers whose tiling costs more.
 * - PDFs: Anthropic documents 1,500-3,000 text tokens per page plus the page as an image.
 * - Audio: about 32 tokens per second (Gemini's documented rate), from 16 kHz 16-bit
 *   PCM (32,000 bytes per second) as the densest common encoding: one token per 1,000 bytes.
 * - Anything else inline is read as text: about four bytes per token.
 */
export const IMAGE_TOKEN_BOUND = 2500;
const PDF_PAGE_TOKEN_BOUND = 3000 + IMAGE_TOKEN_BOUND;
const AUDIO_BYTES_PER_TOKEN = 1000;
const TEXT_BYTES_PER_TOKEN = 4;

const PDF_PAGE = /\/Type\s*\/Page(?!s)/gu;

function decodedBytes(base64: string): number {
	return Buffer.byteLength(base64, "base64");
}

export function pdfPageCount(base64: string): number {
	const text = Buffer.from(base64, "base64").toString("latin1");
	return Math.max(1, text.match(PDF_PAGE)?.length ?? 0);
}

/** Token bound for inline base64 content of a media type (`image/png`, `application/pdf`, `wav`). */
export function inlineMediaTokens(mediaType: string, base64: string): number {
	const type = mediaType.toLowerCase();
	if (type.startsWith("image/")) {
		return IMAGE_TOKEN_BOUND;
	}
	if (type === "application/pdf") {
		return pdfPageCount(base64) * PDF_PAGE_TOKEN_BOUND;
	}
	if (
		type.startsWith("audio/") ||
		["wav", "mp3", "pcm16", "flac", "ogg", "webm", "m4a"].includes(type)
	) {
		return Math.ceil(decodedBytes(base64) / AUDIO_BYTES_PER_TOKEN);
	}
	return Math.ceil(decodedBytes(base64) / TEXT_BYTES_PER_TOKEN);
}

const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,/u;

/**
 * A payload with its inline base64 media taken out (data URLs, and `data` fields that sit beside a
 * media type or format), and the token bound of what was taken out.
 */
export function withoutInlineMedia(value: unknown): {
	value: unknown;
	tokens: number;
} {
	if (typeof value === "string") {
		const match = DATA_URL.exec(value);
		if (match?.[1] !== undefined) {
			return {
				value: "",
				tokens: inlineMediaTokens(match[1], value.slice(match[0].length)),
			};
		}
		return { value, tokens: 0 };
	}
	if (Array.isArray(value)) {
		let tokens = 0;
		const items = value.map((item) => {
			const stripped = withoutInlineMedia(item);
			tokens += stripped.tokens;
			return stripped.value;
		});
		return { value: items, tokens };
	}
	if (value === null || typeof value !== "object") {
		return { value, tokens: 0 };
	}
	const record = value as Record<string, unknown>;
	const mediaType = record.media_type ?? record.mime_type ?? record.format;
	if (typeof record.data === "string" && typeof mediaType === "string") {
		const { data: _data, ...rest } = record;
		const inner = withoutInlineMedia(rest);
		return {
			value: inner.value,
			tokens: inner.tokens + inlineMediaTokens(mediaType, record.data),
		};
	}
	let tokens = 0;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(record)) {
		const stripped = withoutInlineMedia(item);
		tokens += stripped.tokens;
		out[key] = stripped.value;
	}
	return { value: out, tokens };
}
