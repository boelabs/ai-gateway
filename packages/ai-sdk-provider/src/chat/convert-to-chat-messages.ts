import { audioFormat, topLevelType, toWireFile } from "../shared/files.ts";
import { partOptionsSchema } from "../responses/responses-options.ts";
import { mergeProviderFields } from "../shared/provider-fields.ts";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { resolveFullMediaType } from "@ai-sdk/provider-utils";
import { compact, isRecord } from "../shared/json.ts";

import type {
	LanguageModelV4ToolResultOutput,
	LanguageModelV4FilePart,
	SharedV4ProviderOptions,
	LanguageModelV4Prompt,
	SharedV4Warning,
} from "@ai-sdk/provider";

type ChatMessage = Record<string, unknown>;
type ChatPart = Record<string, unknown>;

function readOptions(
	providerOptions: SharedV4ProviderOptions | undefined,
	names: readonly string[],
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const name of names) {
		Object.assign(merged, providerOptions?.[name]);
	}
	return merged;
}

function partExtras(options: Record<string, unknown>) {
	const parsed = partOptionsSchema.safeParse(options);
	return {
		detail: parsed.data?.imageDetail,
		breakpoint:
			parsed.data?.promptCacheBreakpoint === undefined
				? {}
				: { prompt_cache_breakpoint: { mode: "explicit" } },
	};
}

function filePart(
	part: LanguageModelV4FilePart,
	names: readonly string[],
): ChatPart {
	const mediaType = resolveFullMediaType({ part });
	const file = toWireFile(part.data, mediaType, names);
	if (file === undefined) {
		throw new UnsupportedFunctionalityError({
			functionality: `file reference without a ${names[0] ?? "boelabsGateway"} or openai id`,
		});
	}
	const { detail, breakpoint } = partExtras(
		readOptions(part.providerOptions, names),
	);
	const type = topLevelType(mediaType);
	if (type === "image" && file.kind !== "id") {
		return {
			type: "image_url",
			image_url: compact({
				url: file.kind === "url" ? file.url : file.dataUrl,
				detail,
			}),
			...breakpoint,
		};
	}
	if (type === "audio" && file.kind === "data") {
		const format = audioFormat(mediaType);
		if (format !== undefined) {
			return {
				type: "input_audio",
				input_audio: { data: file.base64, format },
				...breakpoint,
			};
		}
	}
	const filename = part.filename ?? `file.${mediaType.split("/")[1] ?? "bin"}`;
	return {
		type: "file",
		file:
			file.kind === "id"
				? { file_id: file.id }
				: compact({
						filename,
						file_data: file.kind === "url" ? file.url : file.dataUrl,
					}),
		...breakpoint,
	};
}

function toolContent(output: LanguageModelV4ToolResultOutput): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "execution-denied":
			return output.reason ?? "Tool execution denied.";
		case "content":
			return output.value
				.map((item) => (item.type === "text" ? item.text : ""))
				.join("");
		default:
			return "";
	}
}

/**
 * Converts the AI SDK prompt to Chat Completions messages.
 *
 * Assistant turns send back the gateway's message-level `provider_specific_fields` (encrypted
 * reasoning, Anthropic thinking blocks, Gemini text signatures), which standard OpenAI-compatible
 * clients drop, and the reasoning text, which some compatible providers need back.
 */
export function convertToChatMessages({
	prompt,
	optionNames,
	systemMessageMode,
}: {
	prompt: LanguageModelV4Prompt;
	optionNames: readonly string[];
	systemMessageMode: "system" | "developer";
}): { messages: ChatMessage[]; warnings: SharedV4Warning[] } {
	const messages: ChatMessage[] = [];
	const warnings: SharedV4Warning[] = [];

	for (const message of prompt) {
		switch (message.role) {
			case "system":
				messages.push({ role: systemMessageMode, content: message.content });
				break;

			case "user": {
				const [only] = message.content;
				if (
					message.content.length === 1 &&
					only?.type === "text" &&
					partExtras(readOptions(only.providerOptions, optionNames)).breakpoint
						.prompt_cache_breakpoint === undefined
				) {
					messages.push({ role: "user", content: only.text });
					break;
				}
				messages.push({
					role: "user",
					content: message.content.map(
						(part): ChatPart =>
							part.type === "text"
								? {
										type: "text",
										text: part.text,
										...partExtras(
											readOptions(part.providerOptions, optionNames),
										).breakpoint,
									}
								: filePart(part, optionNames),
					),
				});
				break;
			}

			case "assistant": {
				let text = "";
				let reasoning = "";
				let fields: Record<string, unknown> | undefined;
				const toolCalls: ChatMessage[] = [];
				for (const part of message.content) {
					const options = readOptions(part.providerOptions, optionNames);
					if (isRecord(options.providerSpecificFields)) {
						fields = mergeProviderFields(
							fields,
							options.providerSpecificFields,
						);
					}
					switch (part.type) {
						case "text":
							text += part.text;
							break;
						case "reasoning":
							reasoning += part.text;
							break;
						case "tool-call":
							if (part.providerExecuted !== true) {
								toolCalls.push({
									id: part.toolCallId,
									type: "function",
									function: {
										name: part.toolName,
										arguments: JSON.stringify(part.input ?? {}),
									},
								});
							}
							break;
						case "tool-result":
							break;
						default:
							warnings.push({
								type: "other",
								message: `Skipped an assistant ${part.type} part: Chat Completions has no input for it.`,
							});
					}
				}
				messages.push(
					compact({
						role: "assistant",
						content: text.length > 0 || toolCalls.length === 0 ? text : null,
						reasoning: reasoning.length > 0 ? reasoning : undefined,
						tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
						provider_specific_fields: fields,
					}),
				);
				break;
			}

			case "tool":
				for (const part of message.content) {
					if (part.type === "tool-result") {
						messages.push({
							role: "tool",
							tool_call_id: part.toolCallId,
							content: toolContent(part.output),
						});
					}
				}
				break;

			default:
				break;
		}
	}

	return { messages, warnings };
}
