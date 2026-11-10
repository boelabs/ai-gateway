import type { MessagesTokenCountRequest } from "./messages.ts";

/**
 * Upper bound for one image: Claude resizes images to at most about 1.15 megapixels, and an image
 * costs about width × height / 750 tokens, so a full-size image is about 1,600 tokens.
 */
const IMAGE_TOKENS = 1600;
/** Anthropic: each PDF page costs 1,500-3,000 text tokens plus the page rendered as an image. */
const PDF_PAGE_TOKENS = 3000 + IMAGE_TOKENS;

const PDF_PAGE = /\/Type\s*\/Page(?!s)/gu;

function pdfPages(base64: string): number {
	const text = Buffer.from(base64, "base64").toString("latin1");
	return Math.max(1, text.match(PDF_PAGE)?.length ?? 0);
}

/** Tokens for an inline base64 source, which costs by what it renders to, not by its bytes. */
function sourceTokens(mediaType: unknown, data: string): number {
	if (typeof mediaType === "string" && mediaType.startsWith("image/")) {
		return IMAGE_TOKENS;
	}
	if (mediaType === "application/pdf") {
		return pdfPages(data) * PDF_PAGE_TOKENS;
	}
	return Math.ceil(Buffer.byteLength(data, "base64") / 4);
}

/** The input with inline media taken out, and the tokens that media is estimated to cost. */
function withoutInlineMedia(value: unknown): {
	value: unknown;
	tokens: number;
} {
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
	if (record.type === "base64" && typeof record.data === "string") {
		return {
			value: { ...record, data: "" },
			tokens: sourceTokens(record.media_type, record.data),
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

/**
 * Deterministic portable fallback for providers without a native token-count API: about four bytes
 * of JSON per token for text and structure, and inline images and PDFs by what Anthropic documents
 * they cost rather than by the size of their base64.
 */
export function estimateMessagesInputTokens(
	request: MessagesTokenCountRequest,
): number {
	const { model: _model, extra_body: _extraBody, ...input } = request;
	const { value, tokens } = withoutInlineMedia(input);
	const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
	return Math.max(1, Math.ceil(bytes / 4) + tokens);
}
