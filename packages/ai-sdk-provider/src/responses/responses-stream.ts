import type { BoelabsGatewayResponsesLanguageModel } from "./responses-language-model.ts";
import { gatewayMetadata } from "../shared/gateway-options.ts";
import { toJSONObject, toJSONValue } from "../shared/json.ts";
import type { ParseResult } from "@ai-sdk/provider-utils";

import {
	summaryPartAddedEventSchema,
	annotationAddedEventSchema,
	outputItemEventSchema,
	responseEventSchema,
	deltaEventSchema,
	errorEventSchema,
	classifyItem,
} from "./responses-api.ts";

import type {
	LanguageModelV4FinishReason,
	LanguageModelV4StreamPart,
	LanguageModelV4Citation,
	LanguageModelV4Usage,
	JSONObject,
	JSONValue,
} from "@ai-sdk/provider";

import {
	finishReasonOf,
	reasoningTexts,
	usageOf,
} from "./responses-mapping.ts";

type Controller = TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface ReasoningState {
	encrypted: string | null;
	/** Summary indexes whose part is open. */
	open: Set<number>;
	sawDelta: boolean;
}

export interface StreamOptions {
	includeRawChunks: boolean;
	wantsLogprobs: boolean;
	responseHeaders: Record<string, string> | undefined;
}

/** Turns Responses stream events into AI SDK stream parts. */
export class StreamState {
	private finishReason: LanguageModelV4FinishReason = {
		unified: "other",
		raw: undefined,
	};
	private usage: LanguageModelV4Usage = usageOf(undefined);
	private terminated = false;
	private hasFunctionCall = false;
	private metadata: JSONObject = {};
	private readonly logprobs: JSONValue[] = [];
	private readonly openText = new Set<string>();
	/** Messages whose text arrived as deltas. */
	private readonly streamedText = new Set<string>();
	private readonly citations = new Map<string, LanguageModelV4Citation[]>();
	private readonly reasoning = new Map<string, ReasoningState>();
	/** Function calls in progress, by output index. */
	private readonly calls = new Map<number, { id: string; name: string }>();

	private readonly model: BoelabsGatewayResponsesLanguageModel;
	private readonly options: StreamOptions;

	constructor(
		model: BoelabsGatewayResponsesLanguageModel,
		options: StreamOptions,
	) {
		this.model = model;
		this.options = options;
		this.metadata = toJSONObject(gatewayMetadata(options.responseHeaders));
	}

	handle(
		chunk: ParseResult<{ type: string; [key: string]: unknown }>,
		controller: Controller,
	): void {
		if (this.options.includeRawChunks) {
			controller.enqueue({ type: "raw", rawValue: chunk.rawValue });
		}
		if (!chunk.success) {
			this.finishReason = { unified: "error", raw: undefined };
			controller.enqueue({ type: "error", error: chunk.error });
			return;
		}
		const { value } = chunk;
		switch (value.type) {
			case "response.created":
			case "response.in_progress":
				this.onResponseStart(value, controller);
				break;
			case "response.completed":
			case "response.incomplete":
			case "response.failed":
				this.onResponseEnd(value, controller);
				break;
			case "response.output_item.added":
				this.onItemAdded(value, controller);
				break;
			case "response.output_item.done":
				this.onItemDone(value, controller);
				break;
			case "response.output_text.delta":
			case "response.refusal.delta": {
				const event = deltaEventSchema.safeParse(value);
				if (event.success) {
					this.ensureText(event.data.item_id, controller);
					this.streamedText.add(event.data.item_id);
					controller.enqueue({
						type: "text-delta",
						id: event.data.item_id,
						delta: event.data.delta,
					});
					if (this.options.wantsLogprobs && event.data.logprobs != null) {
						this.logprobs.push(toJSONValue(event.data.logprobs));
					}
				}
				break;
			}
			case "response.output_text.annotation.added":
				this.onAnnotation(value, controller);
				break;
			case "response.function_call_arguments.delta": {
				const event = deltaEventSchema.safeParse(value);
				const call =
					event.success && event.data.output_index != null
						? this.calls.get(event.data.output_index)
						: undefined;
				if (event.success && call !== undefined) {
					controller.enqueue({
						type: "tool-input-delta",
						id: call.id,
						delta: event.data.delta,
					});
				}
				break;
			}
			case "response.reasoning_summary_part.added": {
				const event = summaryPartAddedEventSchema.safeParse(value);
				if (event.success) {
					this.openReasoning(
						event.data.item_id,
						event.data.summary_index,
						controller,
					);
				}
				break;
			}
			case "response.reasoning_summary_text.delta": {
				const event = deltaEventSchema.safeParse(value);
				if (event.success) {
					const index = event.data.summary_index ?? 0;
					this.openReasoning(event.data.item_id, index, controller);
					const reasoning = this.reasoning.get(event.data.item_id);
					if (reasoning !== undefined) {
						reasoning.sawDelta = true;
					}
					controller.enqueue({
						type: "reasoning-delta",
						id: `${event.data.item_id}:${index}`,
						delta: event.data.delta,
					});
				}
				break;
			}
			case "error": {
				const event = errorEventSchema.safeParse(value);
				this.finishReason = { unified: "error", raw: undefined };
				controller.enqueue({
					type: "error",
					error: event.success ? event.data : value,
				});
				break;
			}
			default:
				// `response.reasoning_text.*` mirrors the summary events; other events carry
				// nothing the AI SDK stream has a part for.
				break;
		}
	}

	finish(controller: Controller): void {
		for (const id of this.openText) {
			controller.enqueue({ type: "text-end", id });
		}
		for (const [itemId, reasoning] of this.reasoning) {
			this.closeReasoning(itemId, reasoning, controller);
		}
		if (!this.terminated && this.finishReason.unified !== "error") {
			this.finishReason = { unified: "interrupted", raw: undefined };
		}
		if (this.options.wantsLogprobs) {
			this.metadata.logprobs = this.logprobs;
		}
		controller.enqueue({
			type: "finish",
			finishReason: this.finishReason,
			usage: this.usage,
			providerMetadata: { [this.model.metadataName]: this.metadata },
		});
	}

	private onResponseStart(value: unknown, controller: Controller): void {
		const event = responseEventSchema.safeParse(value);
		if (!event.success || this.metadata.responseId !== undefined) {
			return;
		}
		const { response } = event.data;
		this.metadata.responseId = response.id;
		controller.enqueue({
			type: "response-metadata",
			id: response.id,
			...(response.created_at == null
				? {}
				: { timestamp: new Date(response.created_at * 1000) }),
			...(response.model == null ? {} : { modelId: response.model }),
		});
	}

	private onResponseEnd(value: unknown, controller: Controller): void {
		const event = responseEventSchema.safeParse(value);
		if (!event.success) {
			return;
		}
		const { response } = event.data;
		this.terminated = true;
		this.finishReason = finishReasonOf(
			response.status ??
				(event.data.type === "response.failed" ? "failed" : undefined),
			response.incomplete_details?.reason,
			this.hasFunctionCall,
		);
		this.usage = usageOf(response.usage);
		this.metadata = {
			...this.metadata,
			...this.model.responseMetadata(
				response,
				this.options.responseHeaders,
				response,
				undefined,
			),
		};
		if (event.data.type === "response.failed") {
			this.finishReason = { unified: "error", raw: "failed" };
			controller.enqueue({
				type: "error",
				error: response.error ?? { message: "The response failed." },
			});
		}
	}

	private onItemAdded(value: unknown, controller: Controller): void {
		const event = outputItemEventSchema.safeParse(value);
		if (!event.success) {
			return;
		}
		const classified = classifyItem(event.data.item);
		switch (classified.kind) {
			case "message":
				this.ensureText(classified.item.id, controller, classified.item.phase);
				break;
			case "reasoning":
				this.reasoning.set(classified.item.id, {
					encrypted: classified.item.encrypted_content ?? null,
					open: new Set(),
					sawDelta: false,
				});
				this.openReasoning(classified.item.id, 0, controller);
				break;
			case "function_call":
				this.calls.set(event.data.output_index, {
					id: classified.item.call_id,
					name: classified.item.name,
				});
				controller.enqueue({
					type: "tool-input-start",
					id: classified.item.call_id,
					toolName: classified.item.name,
				});
				break;
			default:
				break;
		}
	}

	private onItemDone(value: unknown, controller: Controller): void {
		const event = outputItemEventSchema.safeParse(value);
		if (!event.success) {
			return;
		}
		const classified = classifyItem(event.data.item);
		switch (classified.kind) {
			case "message": {
				const { item } = classified;
				for (const part of item.content) {
					if (
						part.type === "output_text" &&
						"text" in part &&
						!this.streamedText.has(item.id)
					) {
						// The text never streamed as deltas: send it whole.
						this.ensureText(item.id, controller, item.phase);
						controller.enqueue({
							type: "text-delta",
							id: item.id,
							delta: String(part.text),
						});
					}
				}
				if (this.openText.delete(item.id)) {
					const citations = this.citations.get(item.id) ?? [];
					controller.enqueue({
						type: "text-end",
						id: item.id,
						...(citations.length > 0 ? { citations } : {}),
						providerMetadata: this.model.itemMetadata(item.id, {
							phase: item.phase ?? undefined,
						}),
					});
				}
				break;
			}
			case "reasoning": {
				const { item } = classified;
				const reasoning = this.reasoning.get(item.id) ?? {
					encrypted: null,
					open: new Set<number>(),
					sawDelta: false,
				};
				reasoning.encrypted = item.encrypted_content ?? reasoning.encrypted;
				this.reasoning.set(item.id, reasoning);
				if (!reasoning.sawDelta) {
					reasoningTexts(item).forEach((text, index) => {
						this.openReasoning(item.id, index, controller);
						if (text.length > 0) {
							controller.enqueue({
								type: "reasoning-delta",
								id: `${item.id}:${index}`,
								delta: text,
							});
						}
					});
					if (reasoning.open.size === 0) {
						this.openReasoning(item.id, 0, controller);
					}
				}
				this.closeReasoning(item.id, reasoning, controller);
				this.reasoning.delete(item.id);
				break;
			}
			case "function_call": {
				const { item } = classified;
				this.hasFunctionCall = true;
				if (!this.calls.has(event.data.output_index)) {
					controller.enqueue({
						type: "tool-input-start",
						id: item.call_id,
						toolName: item.name,
					});
				}
				this.calls.delete(event.data.output_index);
				controller.enqueue({ type: "tool-input-end", id: item.call_id });
				controller.enqueue({
					type: "tool-call",
					toolCallId: item.call_id,
					toolName: item.name,
					input: item.arguments,
					providerMetadata: this.model.itemMetadata(item.id ?? undefined, {}),
				});
				break;
			}
			default:
				break;
		}
	}

	private onAnnotation(value: unknown, controller: Controller): void {
		const event = annotationAddedEventSchema.safeParse(value);
		if (!event.success) {
			return;
		}
		const source = this.model.sourceOf(event.data.annotation);
		if (source === undefined) {
			return;
		}
		controller.enqueue(source);
		const citations = this.citations.get(event.data.item_id) ?? [];
		const { annotation } = event.data;
		citations.push({
			source,
			...(annotation.start_index == null
				? {}
				: { startIndex: annotation.start_index }),
			...(annotation.end_index == null
				? {}
				: { endIndex: annotation.end_index }),
		});
		this.citations.set(event.data.item_id, citations);
	}

	private ensureText(
		id: string,
		controller: Controller,
		phase?: string | null,
	): void {
		if (this.openText.has(id)) {
			return;
		}
		this.openText.add(id);
		controller.enqueue({
			type: "text-start",
			id,
			providerMetadata: this.model.itemMetadata(id, {
				phase: phase ?? undefined,
			}),
		});
	}

	private openReasoning(
		itemId: string,
		index: number,
		controller: Controller,
	): void {
		let reasoning = this.reasoning.get(itemId);
		if (reasoning === undefined) {
			reasoning = { encrypted: null, open: new Set(), sawDelta: false };
			this.reasoning.set(itemId, reasoning);
		}
		if (reasoning.open.has(index)) {
			return;
		}
		reasoning.open.add(index);
		controller.enqueue({
			type: "reasoning-start",
			id: `${itemId}:${index}`,
			providerMetadata: this.model.itemMetadata(itemId, {
				reasoningEncryptedContent: reasoning.encrypted,
			}),
		});
	}

	private closeReasoning(
		itemId: string,
		reasoning: ReasoningState,
		controller: Controller,
	): void {
		for (const index of [...reasoning.open].sort((a, b) => a - b)) {
			controller.enqueue({
				type: "reasoning-end",
				id: `${itemId}:${index}`,
				providerMetadata: this.model.itemMetadata(itemId, {
					reasoningEncryptedContent: reasoning.encrypted,
				}),
			});
		}
		reasoning.open.clear();
	}
}
