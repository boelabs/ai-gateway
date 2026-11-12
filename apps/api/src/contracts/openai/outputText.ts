/**
 * Annotations and log probabilities of output text, between the Chat Completions shape (which the
 * canonical response uses) and the Responses shape.
 *
 * - Chat nests a URL citation (`{ type: "url_citation", url_citation: { url, title, start_index,
 *   end_index } }`); Responses flattens it. Responses' other annotation kinds (file citations, file
 *   paths) have no Chat form and are kept as they are.
 * - Chat reports log probabilities as `{ content: [...] }` on the choice; Responses as an array on
 *   each output_text part. The token entries have the same shape on both.
 */

type Annotation = Record<string, unknown>;

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function chatAnnotationFromResponses(
	annotation: Annotation,
): Annotation {
	if (annotation.type !== "url_citation" || record(annotation.url_citation)) {
		return annotation;
	}
	const { type, ...citation } = annotation;
	return { type, url_citation: citation };
}

export function responsesAnnotationFromChat(
	annotation: Annotation,
): Annotation {
	const citation = record(annotation.url_citation);
	return annotation.type === "url_citation" && citation
		? { type: "url_citation", ...citation }
		: annotation;
}

/** The token entries of a Chat `logprobs` object, if it has any. */
export function logprobTokens(logprobs: unknown): unknown[] | undefined {
	const content = record(logprobs)?.content;
	return Array.isArray(content) && content.length > 0 ? content : undefined;
}

/** Chat's choice-level `logprobs` from Responses' per-part token entries. */
export function chatLogprobs(tokens: unknown[]): Record<string, unknown> {
	return { content: tokens, refusal: null };
}
