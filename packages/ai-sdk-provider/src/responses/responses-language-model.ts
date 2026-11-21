import { convertToResponsesInput } from "./convert-to-responses-input.ts";
import { compact, toJSONObject, toJSONValue } from "../shared/json.ts";
import { prepareResponsesTools } from "./prepare-responses-tools.ts";
import { failedResponseHandler } from "../shared/errors.ts";
import type { ParseResult } from "@ai-sdk/provider-utils";
import { StreamState } from "./responses-stream.ts";

import type {
	LanguageModelV4GenerateResult,
	LanguageModelV4StreamResult,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
	SharedV4ProviderMetadata,
	LanguageModelV4Citation,
	LanguageModelV4Content,
	LanguageModelV4Source,
	LanguageModelV4,
	SharedV4Warning,
	JSONObject,
	JSONValue,
} from "@ai-sdk/provider";

import {
	type ResponsesAnnotation,
	responsesResponseSchema,
	type ResponsesResponse,
	responsesChunkSchema,
	classifyItem,
} from "./responses-api.ts";

import {
	createEventSourceResponseHandler,
	createJsonResponseHandler,
	isCustomReasoning,
	postJsonToApi,
	generateId,
} from "@ai-sdk/provider-utils";

import {
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
	wireModelId,
} from "../shared/gateway-options.ts";

import {
	type BoelabsGatewayResponsesOptions,
	responsesOptionsSchema,
} from "./responses-options.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

import {
	finishReasonOf,
	reasoningTexts,
	textFormat,
	usageOf,
} from "./responses-mapping.ts";

const ENCRYPTED_REASONING = "reasoning.encrypted_content";
const OUTPUT_LOGPROBS = "message.output_text.logprobs";

/** Language model on the gateway's `/v1/responses` (the default text surface). */
export class BoelabsGatewayResponsesLanguageModel implements LanguageModelV4 {
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

	get metadataName(): string {
		return this.config.providerMetadataName;
	}

	private newId(): string {
		return this.config.generateId?.() ?? generateId();
	}

	private async getArgs(options: LanguageModelV4CallOptions) {
		const warnings: SharedV4Warning[] = [];
		const opts: BoelabsGatewayResponsesOptions =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				responsesOptionsSchema,
			)) ?? {};

		for (const [feature, value] of [
			["topK", options.topK],
			["seed", options.seed],
			["stopSequences", options.stopSequences],
		] as const) {
			if (value !== undefined) {
				warnings.push({
					type: "unsupported",
					feature,
					details:
						"The Responses API has no equivalent. Use the Chat Completions surface (`provider.chat()`) for it.",
				});
			}
		}

		const { input, warnings: inputWarnings } = convertToResponsesInput({
			prompt: options.prompt,
			optionNames: this.config.providerOptionsNames,
			systemMessageMode: opts.systemMessageMode ?? "system",
		});
		warnings.push(...inputWarnings);

		const {
			tools,
			toolChoice,
			warnings: toolWarnings,
		} = prepareResponsesTools({
			tools: options.tools,
			toolChoice: options.toolChoice,
			strict: opts.strictJsonSchema,
		});
		warnings.push(...toolWarnings);

		const effort =
			opts.reasoningEffort ??
			(isCustomReasoning(options.reasoning) ? options.reasoning : undefined);
		const reasoning =
			effort === undefined && opts.reasoningSummary === undefined
				? undefined
				: compact({ effort, summary: opts.reasoningSummary });

		const format = options.responseFormat;
		const text = compact({
			format: textFormat(format, opts.strictJsonSchema),
			verbosity: opts.textVerbosity,
		});

		const { logprobs } = opts;
		const include = [
			...new Set([
				ENCRYPTED_REASONING,
				...(opts.include ?? []),
				...(logprobs === undefined || logprobs === false
					? []
					: [OUTPUT_LOGPROBS]),
			]),
		];

		const body = compact({
			model: wireModelId(this.modelId, opts.serviceMode),
			input,
			instructions: opts.instructions,
			max_output_tokens: options.maxOutputTokens,
			temperature: options.temperature,
			top_p: options.topP,
			presence_penalty: options.presencePenalty,
			frequency_penalty: options.frequencyPenalty,
			text: Object.keys(text).length === 0 ? undefined : text,
			reasoning,
			tools,
			tool_choice: toolChoice,
			parallel_tool_calls: opts.parallelToolCalls,
			store: opts.store,
			previous_response_id: opts.previousResponseId,
			include,
			metadata: opts.metadata,
			service_tier: opts.serviceTier,
			safety_identifier: opts.safetyIdentifier,
			user: opts.user,
			prompt_cache_key: opts.promptCacheKey,
			prompt_cache_retention: opts.promptCacheRetention,
			prompt_cache_options: opts.promptCacheOptions,
			truncation: opts.truncation,
			context_management: opts.contextManagement,
			top_logprobs: typeof logprobs === "number" ? logprobs : undefined,
			extra_body: opts.extraBody,
		});

		return {
			body,
			warnings,
			opts,
			wantsJson: format?.type === "json",
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
		};
	}

	async doGenerate(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4GenerateResult> {
		const { body, warnings, opts, headers } = await this.getArgs(options);
		const url = apiUrl(this.config, "/responses");
		const {
			value: response,
			rawValue,
			responseHeaders,
		} = await postJsonToApi({
			url,
			headers,
			body,
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(
				responsesResponseSchema,
			),
			...transport(this.config, options.abortSignal),
		});

		const content: LanguageModelV4Content[] = [];
		const logprobs: JSONValue[] = [];
		let hasFunctionCall = false;
		const wantsLogprobs =
			opts.logprobs !== undefined && opts.logprobs !== false;

		for (const raw of response.output) {
			const classified = classifyItem(raw);
			if (classified.kind === "message") {
				for (const part of classified.item.content) {
					if (part.type === "output_text" && "text" in part) {
						const annotations = (part.annotations ??
							[]) as ResponsesAnnotation[];
						const sources = annotations
							.map((annotation) => this.sourceOf(annotation))
							.filter((source) => source !== undefined);
						const citations = this.citationsOf(annotations, sources);
						content.push({
							type: "text",
							text: part.text as string,
							...(citations.length > 0 ? { citations } : {}),
							providerMetadata: this.itemMetadata(classified.item.id, {
								phase: classified.item.phase ?? undefined,
							}),
						});
						content.push(...sources);
						if (wantsLogprobs && Array.isArray(part.logprobs)) {
							logprobs.push(toJSONValue(part.logprobs));
						}
					} else if (part.type === "refusal" && "refusal" in part) {
						content.push({
							type: "text",
							text: String(part.refusal),
							providerMetadata: this.itemMetadata(classified.item.id, {
								refusal: true,
							}),
						});
					}
				}
				continue;
			}
			if (classified.kind === "reasoning") {
				const texts = reasoningTexts(classified.item);
				for (const reasoningText of texts.length > 0 ? texts : [""]) {
					content.push({
						type: "reasoning",
						text: reasoningText,
						providerMetadata: this.itemMetadata(classified.item.id, {
							reasoningEncryptedContent:
								classified.item.encrypted_content ?? null,
						}),
					});
				}
				continue;
			}
			if (classified.kind === "function_call") {
				hasFunctionCall = true;
				content.push({
					type: "tool-call",
					toolCallId: classified.item.call_id,
					toolName: classified.item.name,
					input: classified.item.arguments,
					providerMetadata: this.itemMetadata(
						classified.item.id ?? undefined,
						{},
					),
				});
			}
		}

		return {
			content,
			finishReason: finishReasonOf(
				response.status,
				response.incomplete_details?.reason,
				hasFunctionCall,
			),
			usage: usageOf(response.usage),
			providerMetadata: {
				[this.metadataName]: this.responseMetadata(
					response,
					responseHeaders,
					rawValue,
					wantsLogprobs ? logprobs : undefined,
				),
			},
			request: { url, body },
			response: {
				id: response.id,
				...(response.created_at == null
					? {}
					: { timestamp: new Date(response.created_at * 1000) }),
				...(response.model == null ? {} : { modelId: response.model }),
				...(responseHeaders === undefined ? {} : { headers: responseHeaders }),
				body: rawValue,
			},
			warnings,
		};
	}

	async doStream(
		options: LanguageModelV4CallOptions,
	): Promise<LanguageModelV4StreamResult> {
		const { body, warnings, opts, headers } = await this.getArgs(options);
		const url = apiUrl(this.config, "/responses");
		const streamBody = { ...body, stream: true };
		const { value: events, responseHeaders } = await postJsonToApi({
			url,
			headers,
			body: streamBody,
			failedResponseHandler,
			successfulResponseHandler:
				createEventSourceResponseHandler(responsesChunkSchema),
			...transport(this.config, options.abortSignal),
		});

		const state = new StreamState(this, {
			includeRawChunks: options.includeRawChunks === true,
			wantsLogprobs: opts.logprobs !== undefined && opts.logprobs !== false,
			responseHeaders,
		});

		return {
			stream: events.pipeThrough(
				new TransformStream<
					ParseResult<{ type: string; [key: string]: unknown }>,
					LanguageModelV4StreamPart
				>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings });
					},
					transform(chunk, controller) {
						state.handle(chunk, controller);
					},
					flush(controller) {
						state.finish(controller);
					},
				}),
			),
			request: { url, body: streamBody },
			...(responseHeaders === undefined
				? {}
				: { response: { headers: responseHeaders } }),
		};
	}

	/* -------------------------------------------------------------- shared with the stream */

	/** @internal */
	itemMetadata(
		itemId: string | undefined,
		extra: Record<string, unknown>,
	): SharedV4ProviderMetadata {
		return {
			[this.metadataName]: toJSONObject(compact({ itemId, ...extra })),
		};
	}

	/** @internal */
	responseMetadata(
		response: Pick<ResponsesResponse, "id" | "service_tier" | "reasoning">,
		headers: Record<string, string> | undefined,
		body: unknown,
		logprobs: JSONValue[] | undefined,
	): JSONObject {
		return toJSONObject(
			compact({
				responseId: response.id,
				serviceTier: response.service_tier ?? undefined,
				reasoningEffort: response.reasoning?.effort ?? undefined,
				logprobs,
				...gatewayMetadata(headers, body),
			}),
		);
	}

	/** @internal */
	sourceOf(annotation: ResponsesAnnotation): LanguageModelV4Source | undefined {
		if (annotation.type === "url_citation" && annotation.url != null) {
			return {
				type: "source",
				sourceType: "url",
				id: this.newId(),
				url: annotation.url,
				...(annotation.title == null ? {} : { title: annotation.title }),
			};
		}
		if (
			(annotation.type === "file_citation" ||
				annotation.type === "container_file_citation") &&
			annotation.file_id != null
		) {
			const filename = annotation.filename ?? annotation.file_id;
			return {
				type: "source",
				sourceType: "document",
				id: this.newId(),
				mediaType: "text/plain",
				title: filename,
				filename,
				providerMetadata: {
					[this.metadataName]: toJSONObject(
						compact({
							fileId: annotation.file_id,
							containerId: annotation.container_id ?? undefined,
						}),
					),
				},
			};
		}
		return undefined;
	}

	/** @internal */
	citationsOf(
		annotations: ResponsesAnnotation[],
		sources: LanguageModelV4Source[],
	): LanguageModelV4Citation[] {
		const citations: LanguageModelV4Citation[] = [];
		let index = 0;
		for (const annotation of annotations) {
			if (this.sourceOf(annotation) === undefined) {
				continue;
			}
			const source = sources[index++];
			if (source === undefined) {
				break;
			}
			citations.push({
				source,
				...(annotation.start_index == null
					? {}
					: { startIndex: annotation.start_index }),
				...(annotation.end_index == null
					? {}
					: { endIndex: annotation.end_index }),
			});
		}
		return citations;
	}
}
