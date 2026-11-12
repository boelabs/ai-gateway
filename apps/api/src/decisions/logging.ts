import type { CostBreakdown } from "#logging/cost.ts";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type DecisionContentPart,
	inputItemParts,
} from "#core/decisions.ts";

const encoder = new TextEncoder();

function count<T extends string>(values: readonly T[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const value of values) {
		out[value] = (out[value] ?? 0) + 1;
	}
	return out;
}

function textBytes(part: DecisionContentPart): number {
	if (part.type === "text") {
		return encoder.encode(part.text).length;
	}
	return part.type === "json"
		? encoder.encode(JSON.stringify(part.data) ?? "").length
		: 0;
}

/** A privacy-safe summary: shapes and sizes, never the input, instructions or options themselves. */
export function decisionRequestSummary(
	request: CanonicalDecisionRequest,
): Record<string, unknown> {
	const parts = request.input.flatMap(inputItemParts);
	const inputTextBytes = parts.reduce((sum, part) => sum + textBytes(part), 0);
	return {
		model: request.model,
		input_items: request.input.length,
		input_parts: count(parts.map((part) => part.type)),
		input_text_bytes: inputTextBytes,
		question_count: request.questions.length,
		question_kinds: count(request.questions.map((question) => question.kind)),
		...(request.promptCache ? { prompt_cache: true } : {}),
	};
}

export function decisionResponseSummary(
	response: CanonicalDecisionResponse,
	cost: CostBreakdown | null,
): Record<string, unknown> {
	return {
		answer_kinds: count(response.answers.map((answer) => answer.kind)),
		...(response.blocked ? { blocked: response.blocked.reason } : {}),
		...(response.model ? { upstream_model: response.model } : {}),
		usage: response.usage
			? {
					input_tokens: response.usage.promptTokens,
					output_tokens: response.usage.completionTokens,
					...(response.usage.cacheReadTokens
						? { cached_tokens: response.usage.cacheReadTokens }
						: {}),
				}
			: null,
		cost_cents: cost?.totalCents ?? null,
	};
}
