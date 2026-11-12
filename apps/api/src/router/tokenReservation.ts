import { withoutInlineMedia } from "#core/mediaTokens.ts";
import type { Usage } from "#core/usage.ts";

/**
 * A provider-agnostic upper bound for quota admission, kept as its two halves: what the request
 * sends and what it may generate. Admission reserves their sum; settlement reconciles to the
 * provider-reported usage, or to `estimateUnreportedUsage` when the provider reported none.
 */
export interface TokenReservation {
	inputTokens: number;
	outputTokens: number;
}

/**
 * One token per UTF-8 byte of text is deliberately conservative across unknown tokenizers. Inline
 * media is not text: it counts by the per-modality bound of what it renders to (`mediaTokens.ts`),
 * not by its base64 characters. Requested output and materialized input bounds are added explicitly.
 */
export function estimateTokenReservation(
	payload: unknown,
	options: {
		maxOutputTokens?: number | null;
		additionalInputTokens?: number;
	} = {},
): TokenReservation {
	const { value, tokens: mediaTokens } = withoutInlineMedia(payload);
	const serialized = JSON.stringify(value) ?? "";
	const input = Buffer.byteLength(serialized, "utf8") + mediaTokens;
	const additional = positiveInteger(options.additionalInputTokens ?? 0);
	return {
		inputTokens: Math.min(Number.MAX_SAFE_INTEGER, input + additional),
		outputTokens: positiveInteger(options.maxOutputTokens ?? 0),
	};
}

export function reservedTotal(reservation: TokenReservation): number {
	return Math.min(
		Number.MAX_SAFE_INTEGER,
		reservation.inputTokens + reservation.outputTokens,
	);
}

/**
 * Usage to settle for an exchange the upstream accepted but never reported usage for (the stream
 * ended before its usage frame, or the provider omits it). Input is the reserved input bound, output
 * is what was observed reaching the gateway, one token per UTF-8 byte. Both are upper bounds, so the
 * request is never charged less than it may have cost; `partial` is what the adapter could report
 * on its own (an `estimated` usage), and the estimate never goes below it.
 */
export function estimateUnreportedUsage(
	reservation: TokenReservation,
	observedOutputTokens: number,
	partial?: Usage | null,
): Usage {
	const promptTokens = Math.max(
		partial?.promptTokens ?? 0,
		reservation.inputTokens,
	);
	const completionTokens = Math.max(
		partial?.completionTokens ?? 0,
		positiveInteger(observedOutputTokens),
	);
	return {
		...partial,
		promptTokens,
		completionTokens,
		totalTokens: promptTokens + completionTokens,
		estimated: true,
	};
}

function positiveInteger(value: number): number {
	return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}
