import { itemOptionsSchema, partOptionsSchema } from "./responses-options.ts";
import { audioFormat, topLevelType, toWireFile } from "../shared/files.ts";
import { UnsupportedFunctionalityError } from "@ai-sdk/provider";
import { resolveFullMediaType } from "@ai-sdk/provider-utils";
import { compact } from "../shared/json.ts";

import type {
	LanguageModelV4ToolResultOutput,
	LanguageModelV4FilePart,
	SharedV4ProviderOptions,
	LanguageModelV4Prompt,
	SharedV4Warning,
} from "@ai-sdk/provider";

type InputItem = Record<string, unknown>;
type InputPart = Record<string, unknown>;

export interface ConvertOptions {
	prompt: LanguageModelV4Prompt;
	/** Namespaces read from part-level `providerOptions`, in merge order. */
	optionNames: readonly string[];
	systemMessageMode: "system" | "developer";
}

/** Merges a part's options under every namespace the provider answers to. */
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

function cacheBreakpoint(options: Record<string, unknown>) {
	const parsed = partOptionsSchema.safeParse(options);
	if (!parsed.success || parsed.data.promptCacheBreakpoint === undefined) {
		return {};
	}
	return { prompt_cache_breakpoint: { mode: "explicit" } };
}

function filePart(
	part: LanguageModelV4FilePart,
	names: readonly string[],
): InputPart {
	const mediaType = resolveFullMediaType({ part });
	const file = toWireFile(part.data, mediaType, names);
	const options = readOptions(part.providerOptions, names);
	const detail = partOptionsSchema.safeParse(options).data?.imageDetail;
	const breakpoint = cacheBreakpoint(options);
	if (file === undefined) {
		throw new UnsupportedFunctionalityError({
			functionality: `file reference without a ${names[0] ?? "boelabsGateway"} or openai id`,
		});
	}
	const type = topLevelType(mediaType);
	if (type === "image") {
		return compact({
			type: "input_image",
			...(file.kind === "id"
				? { file_id: file.id }
				: { image_url: file.kind === "url" ? file.url : file.dataUrl }),
			detail,
			...breakpoint,
		});
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
	const filename =
		part.filename ?? (mediaType === "application/pdf" ? "file.pdf" : undefined);
	switch (file.kind) {
		case "id":
			return { type: "input_file", file_id: file.id, ...breakpoint };
		case "url":
			return { type: "input_file", file_url: file.url, ...breakpoint };
		default:
			return compact({
				type: "input_file",
				filename: filename ?? `file.${mediaType.split("/")[1] ?? "bin"}`,
				file_data: file.dataUrl,
				...breakpoint,
			});
	}
}

function toolOutput(
	output: LanguageModelV4ToolResultOutput,
	names: readonly string[],
): string | InputPart[] {
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
			return output.value.flatMap((item): InputPart[] => {
				if (item.type === "text") {
					return [{ type: "input_text", text: item.text }];
				}
				if (item.type === "file") {
					return [
						filePart(
							{
								type: "file",
								data: item.data,
								mediaType: item.mediaType,
								...(item.filename === undefined
									? {}
									: { filename: item.filename }),
							},
							names,
						),
					];
				}
				return [];
			});
		default:
			return "";
	}
}

/**
 * Converts the AI SDK prompt to Responses `input` items.
 *
 * Assistant turns are replayed as full items, never as `item_reference`s: the history is in hand,
 * and replaying it is what lets the gateway restore provider state (encrypted reasoning, signed
 * thinking, thought signatures) whichever provider serves the next turn. Reasoning and message
 * items keep their ids for the same reason.
 */
export function convertToResponsesInput({
	prompt,
	optionNames,
	systemMessageMode,
}: ConvertOptions): { input: InputItem[]; warnings: SharedV4Warning[] } {
	const input: InputItem[] = [];
	const warnings: SharedV4Warning[] = [];

	for (const message of prompt) {
		switch (message.role) {
			case "system":
				input.push({ role: systemMessageMode, content: message.content });
				break;

			case "user": {
				const content = message.content.map((part): InputPart => {
					if (part.type === "text") {
						return {
							type: "input_text",
							text: part.text,
							...cacheBreakpoint(
								readOptions(part.providerOptions, optionNames),
							),
						};
					}
					return filePart(part, optionNames);
				});
				input.push({ role: "user", content });
				break;
			}

			case "assistant":
				convertAssistant(message.content, optionNames, input, warnings);
				break;

			case "tool":
				for (const part of message.content) {
					if (part.type === "tool-result") {
						input.push({
							type: "function_call_output",
							call_id: part.toolCallId,
							output: toolOutput(part.output, optionNames),
						});
					}
				}
				break;

			default:
				break;
		}
	}

	return { input, warnings };
}

type AssistantContent = Extract<
	LanguageModelV4Prompt[number],
	{ role: "assistant" }
>["content"];

function convertAssistant(
	content: AssistantContent,
	names: readonly string[],
	input: InputItem[],
	warnings: SharedV4Warning[],
): void {
	// Consecutive parts of one output item (text of a message, summaries of a reasoning item)
	// fold back into that item.
	let message:
		| {
				id: string | undefined;
				phase: string | undefined;
				content: InputPart[];
		  }
		| undefined;
	const reasoningById = new Map<string, InputItem>();

	const closeMessage = () => {
		if (message !== undefined) {
			input.push(
				compact({
					type: "message",
					role: "assistant",
					id: message.id,
					phase: message.phase,
					content: message.content,
				}),
			);
			message = undefined;
		}
	};

	for (const part of content) {
		const state = itemOptionsSchema.safeParse(
			readOptions(part.providerOptions, names),
		).data;
		const itemId = state?.itemId ?? undefined;

		switch (part.type) {
			case "text": {
				if (message === undefined || message.id !== itemId) {
					closeMessage();
					message = {
						id: itemId,
						phase: state?.phase ?? undefined,
						content: [],
					};
				}
				message.content.push({
					type: "output_text",
					text: part.text,
					annotations: [],
				});
				break;
			}

			case "reasoning": {
				closeMessage();
				const encrypted = state?.reasoningEncryptedContent ?? undefined;
				const existing =
					itemId === undefined ? undefined : reasoningById.get(itemId);
				const summary =
					part.text.length > 0
						? [{ type: "summary_text", text: part.text }]
						: [];
				if (existing !== undefined) {
					(existing.summary as InputPart[]).push(...summary);
					if (encrypted !== undefined) {
						existing.encrypted_content = encrypted;
					}
					break;
				}
				if (itemId === undefined && encrypted === undefined) {
					warnings.push({
						type: "other",
						message:
							"Skipped a reasoning part without gateway state (no item id or encrypted content).",
					});
					break;
				}
				const item = compact({
					type: "reasoning",
					id: itemId,
					encrypted_content: encrypted,
					summary,
				});
				if (itemId !== undefined) {
					reasoningById.set(itemId, item);
				}
				input.push(item);
				break;
			}

			case "tool-call": {
				closeMessage();
				if (part.providerExecuted === true) {
					// Built-in tool items are the provider's own; their outcome is already in the
					// text that follows, and they cannot be replayed to another provider.
					break;
				}
				input.push(
					compact({
						type: "function_call",
						id: itemId,
						call_id: part.toolCallId,
						name: part.toolName,
						arguments: JSON.stringify(part.input ?? {}),
					}),
				);
				break;
			}

			case "tool-result":
				// Results of provider-executed tools: see above.
				break;

			default:
				warnings.push({
					type: "other",
					message: `Skipped an assistant ${part.type} part: the Responses API has no input for it.`,
				});
				break;
		}
	}
	closeMessage();
}
