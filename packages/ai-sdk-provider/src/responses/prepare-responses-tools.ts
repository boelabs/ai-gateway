import { compact } from "../shared/json.ts";

import type {
	LanguageModelV4CallOptions,
	SharedV4Warning,
} from "@ai-sdk/provider";

type Tools = NonNullable<LanguageModelV4CallOptions["tools"]>;
type ToolChoice = LanguageModelV4CallOptions["toolChoice"];

export interface PreparedResponsesTools {
	tools: Record<string, unknown>[] | undefined;
	toolChoice: unknown;
	warnings: SharedV4Warning[];
}

/**
 * Function tools only. Provider-executed tools (OpenAI's web search, file search, …) run on one
 * provider, so a model that uses them could no longer be served by the rest of its pool.
 */
export function prepareResponsesTools({
	tools,
	toolChoice,
	strict,
}: {
	tools: Tools | undefined;
	toolChoice: ToolChoice;
	strict: boolean | undefined;
}): PreparedResponsesTools {
	const warnings: SharedV4Warning[] = [];
	const wireTools: Record<string, unknown>[] = [];
	for (const tool of tools ?? []) {
		if (tool.type === "function") {
			wireTools.push(
				compact({
					type: "function",
					name: tool.name,
					description: tool.description,
					parameters: tool.inputSchema,
					strict: tool.strict ?? strict,
				}),
			);
		} else {
			warnings.push({
				type: "unsupported",
				feature: `provider tool ${tool.id}`,
				details: "Only function tools are sent to the gateway.",
			});
		}
	}
	if (wireTools.length === 0) {
		return { tools: undefined, toolChoice: undefined, warnings };
	}
	let wireChoice: unknown;
	switch (toolChoice?.type) {
		case "auto":
		case "none":
		case "required":
			wireChoice = toolChoice.type;
			break;
		case "tool":
			wireChoice = { type: "function", name: toolChoice.toolName };
			break;
		default:
			wireChoice = undefined;
	}
	return { tools: wireTools, toolChoice: wireChoice, warnings };
}
