import { compact, toJSONObject, toJSONValue } from "../shared/json.ts";
import { convertToChatMessages } from "./convert-to-chat-messages.ts";
import { failedResponseHandler } from "../shared/errors.ts";
import type { ParseResult } from "@ai-sdk/provider-utils";
import { toLanguageModelUsage } from "../shared/usage.ts";

import type {
	LanguageModelV4GenerateResult,
	LanguageModelV4FinishReason,
	LanguageModelV4StreamResult,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	SharedV4ProviderMetadata,
	LanguageModelV4Content,
	LanguageModelV4Source,
	LanguageModelV4Usage,
	LanguageModelV4,
	SharedV4Warning,
	JSONObject,
} from "@ai-sdk/provider";

import {
	createEventSourceResponseHandler,
	createJsonResponseHandler,
	StreamingToolCallTracker,
	isCustomReasoning,
	postJsonToApi,
	generateId,
} from "@ai-sdk/provider-utils";

import {
	type ChatAnnotation,
	chatResponseSchema,
	chatChunkSchema,
	type ChatChunk,
	type ChatUsage,
} from "./chat-api.ts";

import {
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
	wireModelId,
} from "../shared/gateway-options.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

import {
	mergeProviderFields,
	withoutStreamFields,
} from "../shared/provider-fields.ts";

import {
	type BoelabsGatewayChatOptions,
	chatOptionsSchema,
} from "./chat-options.ts";

function usageOf(usage: ChatUsage | null | undefined): LanguageModelV4Usage {
	return toLanguageModelUsage(
		usage == null
			? undefined
			: {
					input: usage.prompt_tokens,
					cacheRead: usage.prompt_tokens_details?.cached_tokens,
					cacheWrite: usage.prompt_tokens_details?.cache_write_tokens,
					output: usage.completion_tokens,
					reasoning: usage.completion_tokens_details?.reasoning_tokens,
				},
		usage,
	);
}

function finishReasonOf(
	raw: string | null | undefined,
): LanguageModelV4FinishReason {
	switch (raw) {
		case "stop":
			return { unified: "stop", raw };
		case "length":
			return { unified: "length", raw };
		case "content_filter":
			return { unified: "content-filter", raw };
		case "tool_calls":
		case "function_call":
			return { unified: "tool-calls", raw };
		case null:
		case undefined:
			return { unified: "other", raw: undefined };
		default:
			return { unified: "other", raw };
	}
}

function chatToolChoice(
	choice: LanguageModelV4CallOptions["toolChoice"],
): unknown {
	if (choice === undefined) {
		return undefined;
	}
	return choice.type === "tool"
		? { type: "function", function: { name: choice.toolName } }
		: choice.type;
}

function chatResponseFormat(
	format: LanguageModelV4CallOptions["responseFormat"],
	strict: boolean | undefined,
): Record<string, unknown> | undefined {
	if (format?.type !== "json") {
		return undefined;
	}
	if (format.schema === undefined) {
		return { type: "json_object" };
	}
	return {
		type: "json_schema",
		json_schema: compact({
			name: format.name ?? "response",
			description: format.description,
			schema: format.schema,
			strict,
		}),
	};
}

function chatResultMetadata(
	chunk: { service_tier?: string | null | undefined },
	headers: Record<string, string> | undefined,
	body: unknown,
	logprobs: unknown,
): JSONObject {
	return toJSONObject(
		compact({
			serviceTier: chunk.service_tier ?? undefined,
			logprobs: logprobs === undefined ? undefined : toJSONValue(logprobs),
			...gatewayMetadata(headers, body),
		}),
	);
}

/** Language model on the gateway's `/v1/chat/completions`. */
export class BoelabsGatewayChatLanguageModel implements LanguageModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;
	readonly supportedUrls: Record<string, RegExp[]> = {
		"image/*": [/^https:\/\/.*$/u],
		"application/pdf": [/^https:\/\/.*$/u],
	};

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	private get metadataName(): string {
		return this.config.providerMetadataName;
	}

	private async getArgs(options: LanguageModelV4CallOptions) {
		const warnings: SharedV4Warning[] = [];
		const opts: BoelabsGatewayChatOptions =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				chatOptionsSchema,
			)) ?? {};

		const { messages, warnings: messageWarnings } = convertToChatMessages({
			prompt: options.prompt,
			optionNames: this.config.providerOptionsNames,
			systemMessageMode: opts.systemMessageMode ?? "system",
		});
		warnings.push(...messageWarnings);

		const tools: Record<string, unknown>[] = [];
		for (const tool of options.tools ?? []) {
			if (tool.type === "function") {
				tools.push({
					type: "function",
					function: compact({
						name: tool.name,
						description: tool.description,
						parameters: tool.inputSchema,
						strict: tool.strict ?? opts.strictJsonSchema,
					}),
				});
			} else {
				warnings.push({
					type: "unsupported",
					feature: `provider tool ${tool.id}`,
					details: "Only function tools are sent to the gateway.",
				});
			}
		}

		const toolChoice = chatToolChoice(options.toolChoice);

		const format = options.responseFormat;
		const effort =
			opts.reasoningEffort ??
			(isCustomReasoning(options.reasoning) ? options.reasoning : undefined);
		const { logprobs } = opts;

		const body = compact({
			model: wireModelId(this.modelId, opts.serviceMode),
			messages,
			max_tokens: options.maxOutputTokens,
			temperature: options.temperature,
			top_p: options.topP,
			top_k: options.topK,
			presence_penalty: options.presencePenalty,
			frequency_penalty: options.frequencyPenalty,
			stop: options.stopSequences,
			seed: options.seed,
			response_format: chatResponseFormat(format, opts.strictJsonSchema),
			tools: tools.length > 0 ? tools : undefined,
			tool_choice: tools.length > 0 ? toolChoice : undefined,
			parallel_tool_calls: opts.parallelToolCalls,
			reasoning_effort: effort,
			logprobs: logprobs === undefined || logprobs === false ? undefined : true,
			top_logprobs: typeof logprobs === "number" ? logprobs : undefined,
			logit_bias: opts.logitBias,
			user: opts.user,
			metadata: opts.metadata,
			store: opts.store,
			service_tier: opts.serviceTier,
			safety_identifier: opts.safetyIdentifier,
			prompt_cache_key: opts.promptCacheKey,
			prompt_cache_retention: opts.promptCacheRetention,
			prompt_cache_options: opts.promptCacheOptions,
			verbosity: opts.textVerbosity,
			prediction: opts.prediction,
			extra_body: opts.extraBody,
		});

		return {
			body,
			warnings,
			wantsLogprobs: logprobs !== undefined && logprobs !== false,
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
		};
	}

	private fieldsMetadata(
		fields: Record<string, unknown> | undefined,
	): SharedV4ProviderMetadata | undefined {
		const clean = withoutStreamFields(fields);
		return clean === undefined
			? undefined
			: {
					[this.metadataName]: {
						providerSpecificFields: toJSONObject(clean),
					},
				};
	}

	private sourceOf(
		annotation: ChatAnnotation,
	): LanguageModelV4Source | undefined {
		const citation = annotation.url_citation;
		if (annotation.type !== "url_citation" || citation == null) {
			return undefined;
		}
		return {
			type: "source",
			sourceType: "url",
			id: this.config.generateId?.() ?? generateId(),
			url: citation.url,
			...(citation.title == null ? {} : { title: citation.title }),
		};
	}

	async doGenerate(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4GenerateResult> {
		const { body, warnings, wantsLogprobs, headers } =
			await this.getArgs(options);
		const url = apiUrl(this.config, "/chat/completions");
		const {
			value: response,
			rawValue,
			responseHeaders,
		} = await postJsonToApi({
			url,
			headers,
			body,
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(chatResponseSchema),
			...transport(this.config, options.abortSignal),
		});

		const [choice] = response.choices;
		const message = choice?.message;
		const fieldsMetadata = this.fieldsMetadata(
			message?.provider_specific_fields ?? undefined,
		);
		const content: LanguageModelV4Content[] = [];
		const reasoning = message?.reasoning ?? message?.reasoning_content;
		if (reasoning) {
			content.push({ type: "reasoning", text: reasoning });
		}
		const text = message?.content ?? message?.refusal;
		if (text) {
			content.push({
				type: "text",
				text,
				...(fieldsMetadata === undefined
					? {}
					: { providerMetadata: fieldsMetadata }),
			});
		}
		for (const annotation of message?.annotations ?? []) {
			const source = this.sourceOf(annotation);
			if (source !== undefined) {
				content.push(source);
			}
		}
		for (const call of message?.tool_calls ?? []) {
			content.push({
				type: "tool-call",
				toolCallId: call.id ?? this.config.generateId?.() ?? generateId(),
				toolName: call.function.name,
				input: call.function.arguments,
				...(fieldsMetadata === undefined
					? {}
					: { providerMetadata: fieldsMetadata }),
			});
		}

		return {
			content,
			finishReason: finishReasonOf(choice?.finish_reason),
			usage: usageOf(response.usage),
			providerMetadata: {
				[this.metadataName]: chatResultMetadata(
					response,
					responseHeaders,
					rawValue,
					wantsLogprobs ? (choice?.logprobs ?? null) : undefined,
				),
			},
			request: { url, body },
			response: compact({
				id: response.id ?? undefined,
				timestamp:
					response.created == null
						? undefined
						: new Date(response.created * 1000),
				modelId: response.model ?? undefined,
				headers: responseHeaders,
				body: rawValue,
			}),
			warnings,
		};
	}

	async doStream(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4StreamResult> {
		const { body, warnings, wantsLogprobs, headers } =
			await this.getArgs(options);
		const url = apiUrl(this.config, "/chat/completions");
		const streamBody = {
			...body,
			stream: true,
			stream_options: { include_usage: true },
		};
		const { value: events, responseHeaders } = await postJsonToApi({
			url,
			headers,
			body: streamBody,
			failedResponseHandler,
			successfulResponseHandler:
				createEventSourceResponseHandler(chatChunkSchema),
			...transport(this.config, options.abortSignal),
		});

		let finishReason: LanguageModelV4FinishReason = {
			unified: "interrupted",
			raw: undefined,
		};
		let usage = usageOf(undefined);
		let fields: Record<string, unknown> | undefined;
		let metadata: JSONObject = toJSONObject(gatewayMetadata(responseHeaders));
		let sentMetadata = false;
		let textOpen = false;
		let reasoningOpen = false;
		const logprobs: unknown[] = [];
		let tracker: StreamingToolCallTracker | undefined;
		const textId = "text-0";
		const reasoningId = "reasoning-0";

		return {
			stream: events.pipeThrough(
				new TransformStream<ParseResult<ChatChunk>, LanguageModelV4StreamPart>({
					start: (controller) => {
						tracker = new StreamingToolCallTracker(controller, {
							generateId: this.config.generateId ?? generateId,
							buildToolCallProviderMetadata: () => this.fieldsMetadata(fields),
						});
						controller.enqueue({ type: "stream-start", warnings });
					},
					transform: (chunk, controller) => {
						if (options.includeRawChunks === true) {
							controller.enqueue({ type: "raw", rawValue: chunk.rawValue });
						}
						if (!chunk.success) {
							finishReason = { unified: "error", raw: undefined };
							controller.enqueue({ type: "error", error: chunk.error });
							return;
						}
						const { value } = chunk;
						if (value.error != null) {
							finishReason = { unified: "error", raw: undefined };
							controller.enqueue({ type: "error", error: value.error });
							return;
						}
						if (!sentMetadata && (value.id != null || value.model != null)) {
							sentMetadata = true;
							controller.enqueue({
								type: "response-metadata",
								...compact({
									id: value.id ?? undefined,
									timestamp:
										value.created == null
											? undefined
											: new Date(value.created * 1000),
									modelId: value.model ?? undefined,
								}),
							});
						}
						if (value.usage != null) {
							usage = usageOf(value.usage);
						}
						metadata = {
							...metadata,
							...chatResultMetadata(value, responseHeaders, value, undefined),
						};

						const choice = value.choices?.[0];
						if (choice?.finish_reason != null) {
							finishReason = finishReasonOf(choice.finish_reason);
						}
						if (wantsLogprobs && choice?.logprobs != null) {
							logprobs.push(choice.logprobs);
						}
						const delta = choice?.delta;
						if (delta == null) {
							return;
						}
						if (delta.provider_specific_fields != null) {
							fields = mergeProviderFields(
								fields,
								delta.provider_specific_fields,
							);
						}
						const reasoning = delta.reasoning ?? delta.reasoning_content;
						if (reasoning) {
							if (!reasoningOpen) {
								reasoningOpen = true;
								controller.enqueue({
									type: "reasoning-start",
									id: reasoningId,
								});
							}
							controller.enqueue({
								type: "reasoning-delta",
								id: reasoningId,
								delta: reasoning,
							});
						}
						const text = delta.content ?? delta.refusal;
						if (text) {
							if (reasoningOpen) {
								reasoningOpen = false;
								controller.enqueue({ type: "reasoning-end", id: reasoningId });
							}
							if (!textOpen) {
								textOpen = true;
								controller.enqueue({ type: "text-start", id: textId });
							}
							controller.enqueue({
								type: "text-delta",
								id: textId,
								delta: text,
							});
						}
						for (const annotation of delta.annotations ?? []) {
							const source = this.sourceOf(annotation);
							if (source !== undefined) {
								controller.enqueue(source);
							}
						}
						for (const call of delta.tool_calls ?? []) {
							if (reasoningOpen) {
								reasoningOpen = false;
								controller.enqueue({ type: "reasoning-end", id: reasoningId });
							}
							tracker?.processDelta({
								index: call.index ?? null,
								id: call.id ?? null,
								function:
									call.function == null
										? null
										: {
												name: call.function.name ?? null,
												arguments: call.function.arguments ?? null,
											},
							});
						}
					},
					flush: (controller) => {
						if (reasoningOpen) {
							controller.enqueue({ type: "reasoning-end", id: reasoningId });
						}
						if (textOpen) {
							const fieldsMetadata = this.fieldsMetadata(fields);
							controller.enqueue({
								type: "text-end",
								id: textId,
								...(fieldsMetadata === undefined
									? {}
									: { providerMetadata: fieldsMetadata }),
							});
						}
						tracker?.flush();
						if (wantsLogprobs) {
							metadata.logprobs = toJSONValue(logprobs);
						}
						controller.enqueue({
							type: "finish",
							finishReason,
							usage,
							providerMetadata: { [this.metadataName]: metadata },
						});
					},
				}),
			),
			request: { url, body: streamBody },
			...(responseHeaders === undefined
				? {}
				: { response: { headers: responseHeaders } }),
		};
	}
}
