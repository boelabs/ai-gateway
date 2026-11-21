import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { toJSONObject } from "./json.ts";

interface TokenCounts {
	input: number | null | undefined;
	cacheRead: number | null | undefined;
	cacheWrite: number | null | undefined;
	output: number | null | undefined;
	reasoning: number | null | undefined;
}

function count(value: number | null | undefined): number | undefined {
	return value ?? undefined;
}

/**
 * The gateway reports cache reads and writes as subsets of the input, and reasoning as a subset
 * of the output, on both text contracts.
 */
export function toLanguageModelUsage(
	counts: TokenCounts | undefined,
	raw: unknown,
): LanguageModelV4Usage {
	if (counts === undefined) {
		return {
			inputTokens: {
				total: undefined,
				noCache: undefined,
				cacheRead: undefined,
				cacheWrite: undefined,
			},
			outputTokens: { total: undefined, text: undefined, reasoning: undefined },
		};
	}
	const input = count(counts.input);
	const cacheRead = count(counts.cacheRead);
	const cacheWrite = count(counts.cacheWrite);
	const output = count(counts.output);
	const reasoning = count(counts.reasoning);
	return {
		inputTokens: {
			total: input,
			noCache:
				input === undefined
					? undefined
					: input - (cacheRead ?? 0) - (cacheWrite ?? 0),
			cacheRead,
			cacheWrite,
		},
		outputTokens: {
			total: output,
			text: output === undefined ? undefined : output - (reasoning ?? 0),
			reasoning,
		},
		raw: toJSONObject(raw),
	};
}
