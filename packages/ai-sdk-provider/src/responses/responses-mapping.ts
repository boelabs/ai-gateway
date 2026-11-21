import { toLanguageModelUsage } from "../shared/usage.ts";
import type { ResponsesUsage } from "./responses-api.ts";
import { compact } from "../shared/json.ts";

import type {
	LanguageModelV4FinishReason,
	LanguageModelV4CallOptions,
	LanguageModelV4Usage,
} from "@ai-sdk/provider";

export function usageOf(
	usage: ResponsesUsage | null | undefined,
): LanguageModelV4Usage {
	return toLanguageModelUsage(
		usage == null
			? undefined
			: {
					input: usage.input_tokens,
					cacheRead: usage.input_tokens_details?.cached_tokens,
					cacheWrite: usage.input_tokens_details?.cache_write_tokens,
					output: usage.output_tokens,
					reasoning: usage.output_tokens_details?.reasoning_tokens,
				},
		usage,
	);
}

export function finishReasonOf(
	status: string | null | undefined,
	incompleteReason: string | null | undefined,
	hasFunctionCall: boolean,
): LanguageModelV4FinishReason {
	if (status === "failed") {
		return { unified: "error", raw: status };
	}
	switch (incompleteReason) {
		case "max_output_tokens":
			return { unified: "length", raw: incompleteReason };
		case "content_filter":
			return { unified: "content-filter", raw: incompleteReason };
		case null:
		case undefined:
			return {
				unified: hasFunctionCall ? "tool-calls" : "stop",
				raw: status ?? undefined,
			};
		default:
			return { unified: "other", raw: incompleteReason };
	}
}

export function reasoningTexts(item: {
	summary?: Array<{ text: string }> | null | undefined;
	content?: Array<{ text: string }> | null | undefined;
}): string[] {
	const summary = (item.summary ?? []).map((part) => part.text);
	return summary.length > 0
		? summary
		: (item.content ?? []).map((part) => part.text);
}

/** `text.format` for the AI SDK's response format. */
export function textFormat(
	format: LanguageModelV4CallOptions["responseFormat"],
	strict: boolean | undefined,
): Record<string, unknown> | undefined {
	if (format?.type !== "json") {
		return undefined;
	}
	if (format.schema === undefined) {
		return { type: "json_object" };
	}
	return compact({
		type: "json_schema",
		name: format.name ?? "response",
		description: format.description,
		schema: format.schema,
		strict,
	});
}
