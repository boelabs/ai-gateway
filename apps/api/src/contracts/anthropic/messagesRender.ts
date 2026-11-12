import { assertNoManagedExtraBodyKeys } from "#core/extraBody.ts";
import { type MessagesRequest, messagesRequestSchema } from "./messages.ts";
import { GatewayError } from "#core/errors.ts";
import type { SSEEvent } from "#core/sse.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";

import {
	anthropicContentBlocksFromProviderFields,
	providerFieldsWithAnthropicContentBlocks,
	anthropicStreamBlockFromProviderFields,
	anthropicStopReasonFromProviderFields,
	hasNonCanonicalAnthropicContent,
	googleContentPartsFromProviderFields,
	providerFieldsWithGoogleContentParts,
	providerFieldsWithAnthropicThinking,
	anthropicThinkingFromProviderFields,
	openaiReasoningFromProviderFields,
	providerFieldsWithOpenAIReasoning,
	messageStateFromProviderFields,
	providerFieldsWithMessageState,
	type OpenAIReasoningStateItem,
	type AnthropicThinkingBlock,
	messageStateMatchesContent,
	anthropicContentMatches,
	type MessageStateCodec,
	mergeProviderFields,
	isGatewayState,
} from "#core/providerSpecificFields.ts";

import {
	providerSpecificFieldsFromExtraContent,
	extraContentFromProviderSpecificFields,
	mergeProviderExtraContent,
	decodeThoughtSignatureId,
	encodeThoughtSignatureId,
	stripThoughtSignatureId,
} from "#core/providerSpecificFields.ts";

import type {
	CanonicalChatStreamChunk,
	CanonicalChatResponse,
	CanonicalFinishReason,
	CanonicalChatRequest,
	CanonicalContentPart,
	CanonicalToolChoice,
	CanonicalMessage,
} from "#core/canonical.ts";

import {
	effortFromBudgetTokens,
	type ReasoningEffort,
	isReasoningEffort,
	summaryForEffort,
} from "#core/reasoning.ts";

/* ====================================================================
 * Anthropic Messages ⟷ canonical types (provider-agnostic render).
 * ==================================================================== */

export interface MessagesRenderOptions {
	publicModel: string;
	/** Seals other providers' message-bound state into a `redacted_thinking` block. */
	messageState?: MessageStateCodec;
}

export interface MessagesCanonicalOptions {
	/** Opens gateway state carriers. Without it they are dropped. */
	messageState?: MessageStateCodec;
	/** The request's `anthropic-beta` header values. */
	betas?: readonly string[];
}

/** Custom tool fields the canonical function tool carries. */
const PORTABLE_TOOL_FIELDS = new Set([
	"name",
	"description",
	"input_schema",
	"strict",
	"cache_control",
]);

/**
 * Documented top-level Messages fields the canonical request has no form for. They reach an
 * Anthropic upstream unchanged and make the request require it; no other provider can honour them.
 */
const NATIVE_TOP_LEVEL_FIELDS = new Set([
	"container",
	"mcp_servers",
	"context_management",
	"inference_geo",
	"service_tier",
	"speed",
	"diagnostics",
]);

const MAPPED_TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set(
	Object.keys(messagesRequestSchema.shape),
);

/** Beta names follow `feature-name-YYYY-MM-DD`; anything else is not a beta Anthropic documents. */
const BETA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}$/u;

function betaNames(values: readonly string[]): string[] {
	const names = values
		.flatMap((value) => value.split(","))
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	const invalid = names.find((name) => !BETA_NAME.test(name));
	if (invalid !== undefined) {
		throw new GatewayError({
			class: "bad_request",
			code: "invalid_request_error",
			param: "anthropic-beta",
			message: `Unexpected value \`${invalid}\` for the anthropic-beta header`,
		});
	}
	return [...new Set(names)];
}

/**
 * The request's top-level fields the canonical request does not map, split into the documented
 * native ones and the rest, which is rejected: a field accepted and then lost is never acceptable.
 */
function nativeTopLevelFields(
	req: MessagesRequest,
): Record<string, unknown> | undefined {
	const native: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(req)) {
		if (MAPPED_TOP_LEVEL_FIELDS.has(key)) {
			continue;
		}
		if (!NATIVE_TOP_LEVEL_FIELDS.has(key)) {
			throw new GatewayError({
				class: "bad_request",
				code: "unknown_parameter",
				param: key,
				message: `Unknown parameter: ${key}`,
			});
		}
		native[key] = structuredClone(value);
	}
	return Object.keys(native).length > 0 ? native : undefined;
}

/** A gateway state carrier: Anthropic clients replay `thinking` blocks verbatim. */
function gatewayStateOf(block: Block): string | undefined {
	if (block.type === "redacted_thinking" && isGatewayState(block.data)) {
		return block.data;
	}
	return block.type === "thinking" && isGatewayState(block.signature)
		? block.signature
		: undefined;
}

/**
 * Restores carriers onto the assistant message that holds them. Gemini state whose text was edited
 * since is discarded, so a signature never reaches the provider next to text that is not its own.
 */
function restoreMessageStates(
	message: CanonicalMessage,
	carriers: string[],
	codec: MessageStateCodec | undefined,
): void {
	for (const carrier of carriers) {
		const state = codec?.decode(carrier);
		if (state === undefined || codec === undefined) {
			continue;
		}
		if (!messageStateMatchesContent(state, message.content)) {
			codec.discard("content_mismatch");
			continue;
		}
		message.providerFields = providerFieldsWithMessageState(
			message.providerFields,
			state,
		);
	}
}

const MESSAGES_EXTRA_BODY_MANAGED_KEYS = [
	"model",
	"max_tokens",
	"messages",
	"system",
	"stream",
	"temperature",
	"top_p",
	"top_k",
	"stop_sequences",
	"tools",
	"tool_choice",
	"metadata",
	"thinking",
	"output_config",
	"extra_body",
] as const;

/* ---------------------------------------------- request -> canonical */

interface Block {
	type?: string;
	text?: string;
	source?: {
		type?: string;
		media_type?: string;
		data?: string;
		url?: string;
		file_id?: string;
	};
	title?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
	provider_specific_fields?: Record<string, unknown>;
	cache_control?: Record<string, unknown>;
	thinking?: string;
	signature?: string;
	data?: string;
	is_error?: boolean;
}

/** Attaches the prompt-caching breakpoint to the canonical part if the block carries it. */
function withCacheControl(
	part: CanonicalContentPart,
	block: { cache_control?: Record<string, unknown> },
): CanonicalContentPart {
	if (block.cache_control !== undefined) {
		part.cacheControl = block.cache_control;
	}
	return part;
}

/** Document fields the canonical file part has no form for. */
const NATIVE_DOCUMENT_FIELDS = ["citations", "context"] as const;

/** A block only Anthropic can read, carried as written. */
function nativePart(block: Block): CanonicalContentPart {
	return {
		type: "file",
		native: structuredClone(block) as Record<string, unknown>,
		...(typeof block.title === "string" ? { filename: block.title } : {}),
	};
}

function needsNativeBlock(block: Block): boolean {
	if (block.type === "text") {
		return Array.isArray((block as { citations?: unknown }).citations);
	}
	if (block.type === "image") {
		return block.source?.type === "file";
	}
	if (block.type === "document") {
		return (
			NATIVE_DOCUMENT_FIELDS.some(
				(field) => (block as Record<string, unknown>)[field] !== undefined,
			) ||
			block.source?.type === "text" ||
			block.source?.type === "content"
		);
	}
	return true;
}

/**
 * One input block as a canonical part. User content the canonical form cannot hold is carried
 * natively; assistant content has its own native carrier (the turn's content blocks), so there
 * `native: false` keeps the portable parts only.
 */
function blockToPart(
	block: Block,
	{ native = true }: { native?: boolean } = {},
): CanonicalContentPart | null {
	if (native && needsNativeBlock(block)) {
		return nativePart(block);
	}
	switch (block.type) {
		case "text":
			return withCacheControl({ type: "text", text: block.text ?? "" }, block);
		case "image": {
			const s = block.source;
			if (s?.type === "base64" && s.media_type && s.data) {
				return withCacheControl(
					{ type: "image", url: `data:${s.media_type};base64,${s.data}` },
					block,
				);
			}
			if (s?.type === "url" && s.url) {
				return withCacheControl({ type: "image", url: s.url }, block);
			}
			return null;
		}
		case "document": {
			const s = block.source;
			if (s?.type === "base64" && s.media_type && s.data) {
				return withCacheControl(
					{
						type: "file",
						fileData: `data:${s.media_type};base64,${s.data}`,
						...(block.title === undefined ? {} : { filename: block.title }),
					},
					block,
				);
			}
			if (s?.type === "url" && s.url) {
				return withCacheControl(
					{
						type: "file",
						fileUrl: s.url,
						...(block.title === undefined ? {} : { filename: block.title }),
					},
					block,
				);
			}
			if (s?.type === "file" && s.file_id) {
				return withCacheControl(
					{
						type: "file",
						fileId: s.file_id,
						...(block.title === undefined ? {} : { filename: block.title }),
					},
					block,
				);
			}
			throw new GatewayError({
				class: "bad_request",
				code: "invalid_file_source",
				param: "messages",
				message: "Document block has an invalid or missing source",
				publicMessage:
					"Document sources must be base64, a public URL, or a provider file reference.",
			});
		}
		default:
			return null;
	}
}

/**
 * System -> canonical content. If any block carries `cache_control` it is preserved as parts (so the
 * adapter can place the breakpoint on the system); otherwise it is flattened to a string (back-compat).
 */
function systemToCanonicalContent(
	system: MessagesRequest["system"],
): string | CanonicalContentPart[] | null {
	if (typeof system === "string") {
		return system || null;
	}
	if (Array.isArray(system)) {
		const parts: CanonicalContentPart[] = [];
		let hasCacheControl = false;
		for (const raw of system) {
			const b = raw as Block;
			if (b.type !== undefined && b.type !== "text") {
				continue;
			}
			if (b.cache_control !== undefined) {
				hasCacheControl = true;
			}
			parts.push(withCacheControl({ type: "text", text: b.text ?? "" }, b));
		}
		if (parts.length === 0) {
			return null;
		}
		if (hasCacheControl) {
			return parts;
		}
		return (
			parts
				.map((p) => (p as { text: string }).text)
				.filter(Boolean)
				.join("\n") || null
		);
	}
	return null;
}

function toolResultToCanonical(
	content: unknown,
): string | CanonicalContentPart[] {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((value): CanonicalContentPart => {
			if (typeof value === "string") {
				return { type: "text", text: value };
			}
			const part = blockToPart(value as Block);
			return part ?? nativePart(value as Block);
		});
	}
	return JSON.stringify(content ?? "");
}

function mapToolChoice(
	tc: MessagesRequest["tool_choice"],
): CanonicalToolChoice | undefined {
	if (!tc) {
		return undefined;
	}
	const { type } = tc as { type?: string };
	if (type === "auto") {
		return "auto";
	}
	if (type === "any") {
		return "required";
	}
	if (type === "none") {
		return "none";
	}
	if (type === "tool") {
		const { name } = tc as { name?: string };
		if (name) {
			return { name };
		}
	}
	throw new GatewayError({
		class: "bad_request",
		code: "invalid_request_error",
		param: "tool_choice",
		message:
			type === "tool"
				? 'tool_choice "tool" requires a name'
				: `Unsupported tool_choice type: ${String(type)}`,
	});
}

function displayFromThinking(
	thinking: MessagesRequest["thinking"],
): "omitted" | "summarized" | undefined {
	const display = thinking?.display;
	return display === "omitted" || display === "summarized"
		? display
		: undefined;
}

function reasoningEffortFromMessages(
	req: MessagesRequest,
): ReasoningEffort | undefined {
	const outputEffort = req.output_config?.effort;
	if (outputEffort !== undefined && req.thinking?.type === "disabled") {
		// Effort applies with or without thinking; with thinking off it steers only the response,
		// which travels as messagesTransport.outputEffort while reasoning stays off.
		return "none";
	}
	if (outputEffort !== undefined) {
		if (!isReasoningEffort(outputEffort)) {
			throw new GatewayError({
				class: "bad_request",
				message: `Unsupported output_config.effort: ${String(outputEffort)}`,
				param: "output_config.effort",
			});
		}
		return outputEffort;
	}

	if (req.thinking === undefined) {
		return undefined;
	}
	if (req.thinking.type === "disabled") {
		return "none";
	}
	const budget = req.thinking.budget_tokens;
	if (typeof budget === "number") {
		return effortFromBudgetTokens(budget);
	}
	if (req.thinking.type === "enabled" || req.thinking.type === "adaptive") {
		return "high";
	}
	return undefined;
}

export function messagesRequestToCanonical(
	req: MessagesRequest,
	options: MessagesCanonicalOptions = {},
): CanonicalChatRequest {
	const messages: CanonicalMessage[] = [];
	if (req.system) {
		const sys = systemToCanonicalContent(req.system);
		if (sys) {
			messages.push({ role: "system", content: sys });
		}
	}

	for (const m of req.messages) {
		if (typeof m.content === "string") {
			messages.push({ role: m.role, content: m.content });
			continue;
		}
		const blocks = m.content as Block[];

		if (m.role === "assistant") {
			const parts: CanonicalContentPart[] = [];
			const toolCalls: NonNullable<CanonicalMessage["toolCalls"]> = [];
			const thinkingBlocks: AnthropicThinkingBlock[] = [];
			const carriers: string[] = [];
			for (const [blockIndex, b] of blocks.entries()) {
				const carrier = gatewayStateOf(b);
				if (carrier !== undefined) {
					carriers.push(carrier);
				} else if (
					b.type === "thinking" &&
					typeof b.thinking === "string" &&
					typeof b.signature === "string" &&
					b.signature.length > 0
				) {
					thinkingBlocks.push({
						type: "thinking",
						thinking: b.thinking,
						signature: b.signature,
					});
				} else if (
					b.type === "redacted_thinking" &&
					typeof b.data === "string"
				) {
					thinkingBlocks.push({ type: "redacted_thinking", data: b.data });
				} else if (b.type === "tool_use") {
					const decoded = decodeThoughtSignatureId(b.id ?? "");
					const extraContent = mergeProviderExtraContent(
						decoded.extraContent,
						extraContentFromProviderSpecificFields(b.provider_specific_fields),
					);
					toolCalls.push({
						id: decoded.id,
						name: b.name ?? "",
						arguments: JSON.stringify(b.input ?? {}),
						...(blocks.some((block) => block.cache_control !== undefined)
							? { contentIndex: blockIndex }
							: {}),
						...(b.cache_control === undefined
							? {}
							: { cacheControl: b.cache_control }),
						...(extraContent === undefined ? {} : { extraContent }),
					});
				} else {
					const p = blockToPart(b, { native: false });
					if (p) {
						parts.push(p);
					}
				}
			}
			const msg: CanonicalMessage = {
				role: "assistant",
				content: parts.length > 0 ? parts : null,
			};
			if (toolCalls.length > 0) {
				msg.toolCalls = toolCalls;
			}
			const nativeBlocks = blocks.filter(
				(block) => gatewayStateOf(block) === undefined,
			) as Record<string, unknown>[];
			if (
				thinkingBlocks.length > 0 ||
				// Thinking counts only when signed (above): unsigned thinking is portable text.
				hasNonCanonicalAnthropicContent(
					nativeBlocks.filter(
						(block) =>
							block.type !== "thinking" && block.type !== "redacted_thinking",
					),
				)
			) {
				// The turn exactly as the client holds it: Anthropic binds thinking to block order and
				// needs server-tool calls and results (their encrypted content) back unchanged.
				const native = providerFieldsWithAnthropicContentBlocks(nativeBlocks);
				msg.providerFields =
					thinkingBlocks.length > 0
						? (mergeProviderFields(
								providerFieldsWithAnthropicThinking(thinkingBlocks),
								native,
							) ?? native)
						: native;
			}
			restoreMessageStates(msg, carriers, options.messageState);
			messages.push(msg);
			continue;
		}

		// user: tool_result -> canonical tool message; the rest -> user content (preserving order).
		let pending: CanonicalContentPart[] = [];
		const flush = (): void => {
			if (pending.length > 0) {
				messages.push({ role: "user", content: pending });
				pending = [];
			}
		};
		for (const b of blocks) {
			if (b.type === "tool_result") {
				flush();
				messages.push({
					role: "tool",
					toolCallId: stripThoughtSignatureId(b.tool_use_id ?? ""),
					content: toolResultToCanonical(b.content),
					...(b.cache_control === undefined
						? {}
						: { cacheControl: b.cache_control }),
					...(b.is_error === undefined ? {} : { toolResultError: b.is_error }),
				});
			} else {
				const p = blockToPart(b);
				if (p) {
					pending.push(p);
				}
			}
		}
		flush();
	}

	const u: CanonicalChatRequest = {
		callType: "chat",
		publicWire: "messages",
		model: req.model,
		messages,
		stream: req.stream,
	};
	if (
		messages.some(
			(message) =>
				Array.isArray(message.content) &&
				message.content.some(
					(part) => part.type === "file" && part.native !== undefined,
				),
		)
	) {
		u.requiresNativeWire = true;
	}
	u.maxTokens = req.max_tokens;
	if (req.temperature !== undefined) {
		u.temperature = req.temperature;
	}
	if (req.top_p !== undefined) {
		u.topP = req.top_p;
	}
	if (req.top_k !== undefined) {
		u.topK = req.top_k;
	}
	if (req.stop_sequences !== undefined) {
		u.stop = req.stop_sequences;
	}
	if (req.metadata !== undefined) {
		u.messagesTransport = { metadata: req.metadata };
	}
	if (req.cache_control !== undefined) {
		assertNoManagedExtraBodyKeys(req.extra_body, ["cache_control"]);
		u.messagesTransport = {
			...u.messagesTransport,
			cacheControl: req.cache_control,
		};
		u.requiresNativeWire = true;
	}
	const outputEffort = req.output_config?.effort;
	if (outputEffort !== undefined && req.thinking?.type === "disabled") {
		if (!isReasoningEffort(outputEffort)) {
			throw new GatewayError({
				class: "bad_request",
				message: `Unsupported output_config.effort: ${String(outputEffort)}`,
				param: "output_config.effort",
			});
		}
		u.messagesTransport = { ...u.messagesTransport, outputEffort };
	}
	const nativeFields = nativeTopLevelFields(req);
	if (nativeFields !== undefined) {
		u.messagesTransport = { ...u.messagesTransport, nativeFields };
		u.requiresNativeWire = true;
	}
	const betas = betaNames(options.betas ?? []);
	if (betas.length > 0) {
		u.messagesTransport = { ...u.messagesTransport, betas };
	}
	const effort = reasoningEffortFromMessages(req);
	const display = displayFromThinking(req.thinking);
	const summary =
		display === "omitted" ? "none" : summaryForEffort(effort, undefined);
	// The exact budget travels beside its effort bucket, so a budget-controlled model gets the number
	// the client asked for rather than the bucket's configured budget.
	const budgetTokens =
		req.thinking?.type === "enabled" &&
		typeof req.thinking.budget_tokens === "number"
			? req.thinking.budget_tokens
			: undefined;
	if (effort !== undefined || display !== undefined) {
		u.reasoning = {
			...(effort === undefined ? {} : { effort }),
			...(summary === undefined ? {} : { summary }),
			...(display === undefined ? {} : { display }),
			...(budgetTokens === undefined ? {} : { budgetTokens }),
		};
	}
	const outputFormat = req.output_config?.format;
	if (outputFormat != null) {
		u.responseFormat = {
			type: "json_schema",
			schema: outputFormat.schema,
			strict: true,
		};
	}
	if (req.extra_body !== undefined) {
		assertNoManagedExtraBodyKeys(
			req.extra_body,
			MESSAGES_EXTRA_BODY_MANAGED_KEYS,
		);
		u.extraBody = req.extra_body;
	}
	if (Array.isArray(req.tools)) {
		const tools: NonNullable<CanonicalChatRequest["tools"]> = [];
		let hasNativeTool = false;
		for (const t of req.tools) {
			const tool = t as {
				type?: string;
				name?: string;
				description?: string;
				input_schema?: Record<string, unknown>;
				strict?: boolean;
				cache_control?: Record<string, unknown>;
			};
			if (typeof tool.name === "string") {
				if (
					typeof tool.type === "string" ||
					tool.input_schema === undefined ||
					// input_examples, defer_loading, eager_input_streaming, allowed_callers...: fields a
					// function tool has no form for, so the definitions travel as written.
					Object.keys(tool).some((key) => !PORTABLE_TOOL_FIELDS.has(key))
				) {
					hasNativeTool = true;
				}
				const entry: NonNullable<CanonicalChatRequest["tools"]>[number] = {
					name: tool.name,
				};
				if (tool.description !== undefined) {
					entry.description = tool.description;
				}
				if (tool.input_schema !== undefined) {
					entry.parameters = tool.input_schema;
				}
				if (tool.strict !== undefined) {
					entry.strict = tool.strict;
				}
				if (tool.cache_control !== undefined) {
					entry.cacheControl = tool.cache_control;
				}
				tools.push(entry);
			}
		}
		if (tools.length > 0) {
			u.tools = tools;
		}
		if (hasNativeTool) {
			u.messagesTransport = {
				...u.messagesTransport,
				rawTools: structuredClone(req.tools),
			};
			u.requiresNativeWire = true;
		}
	}
	const tc = mapToolChoice(req.tool_choice);
	if (tc !== undefined) {
		u.toolChoice = tc;
	}
	const disableParallel = (
		req.tool_choice as { disable_parallel_tool_use?: unknown } | undefined
	)?.disable_parallel_tool_use;
	if (typeof disableParallel === "boolean") {
		u.parallelToolCalls = !disableParallel;
	}
	const carriesNativeMessageState = messages.some((message) => {
		if (
			anthropicThinkingFromProviderFields(message.providerFields) !== undefined
		) {
			return true;
		}
		if (
			message.cacheControl !== undefined ||
			message.toolCalls?.some((call) => call.cacheControl !== undefined)
		) {
			return true;
		}
		return Array.isArray(message.content)
			? message.content.some((part) => part.cacheControl !== undefined)
			: false;
	});
	const carriesNativeToolState = u.tools?.some(
		(tool) => tool.cacheControl !== undefined,
	);
	if (carriesNativeMessageState || carriesNativeToolState) {
		u.requiresNativeWire = true;
	}
	return u;
}

/* ---------------------------------------------- canonical -> response */

function mapStopReason(
	finish: CanonicalFinishReason | null,
	stopSequence?: string | null,
	native?: string,
): string | null {
	if (native !== undefined) {
		return native;
	}
	if (stopSequence) {
		return "stop_sequence";
	}
	switch (finish) {
		case null:
			return null;
		case "length":
			return "max_tokens";
		case "tool_calls":
			return "tool_use";
		case "content_filter":
			return "refusal";
		default:
			return "end_turn";
	}
}

function messagesResponseId(id: string): string {
	return id.startsWith("msg_") ? id : `msg_${randomUUID()}`;
}

/**
 * Full Anthropic usage (final response). Always includes the cache fields (0 if not applicable).
 * In the Anthropic transport the three input buckets are DISJOINT, so we reconstruct the non-cached
 * `input_tokens` by subtracting read+write from the canonical promptTokens (which does include them).
 */
function usageToAnthropic(usage: Usage): Record<string, unknown> {
	const cacheRead = usage.cacheReadTokens ?? 0;
	const cacheWrite = usage.cacheWriteTokens ?? 0;
	return {
		input_tokens: Math.max(0, usage.promptTokens - cacheRead - cacheWrite),
		cache_creation_input_tokens: cacheWrite,
		cache_read_input_tokens: cacheRead,
		...(usage.cacheWriteTokensByTtl === undefined
			? {}
			: {
					cache_creation: {
						ephemeral_5m_input_tokens: usage.cacheWriteTokensByTtl["300"] ?? 0,
						ephemeral_1h_input_tokens: usage.cacheWriteTokensByTtl["3600"] ?? 0,
					},
				}),
		output_tokens: usage.completionTokens,
		...(usage.reasoningTokens === undefined
			? {}
			: { output_tokens_details: { thinking_tokens: usage.reasoningTokens } }),
		...(usage.serverToolCalls === undefined
			? {}
			: {
					server_tool_use: Object.fromEntries(
						Object.entries(usage.serverToolCalls).map(([tool, calls]) => [
							`${tool}_requests`,
							calls,
						]),
					),
				}),
	};
}

function parseArgs(args: string): unknown {
	try {
		return args ? JSON.parse(args) : {};
	} catch {
		return {};
	}
}

type ResponseMessage = CanonicalChatResponse["choices"][number]["message"];

/**
 * Claude's content exactly as returned — thinking between text and tool calls stays where it was,
 * since Anthropic binds each signature to the content before it — while it still says what the
 * canonical message says (a response extension may have rewritten it).
 */
function nativeContent(
	message: ResponseMessage | undefined,
): Record<string, unknown>[] | undefined {
	const native = anthropicContentBlocksFromProviderFields(
		message?.providerFields,
	);
	return native !== undefined &&
		message !== undefined &&
		anthropicContentMatches(native, [message.content], message.toolCalls ?? [])
		? native
		: undefined;
}

function canonicalBlocks(
	message: ResponseMessage | undefined,
): Record<string, unknown>[] {
	const content = message?.content;
	const blocks: Record<string, unknown>[] = [];
	const nativeThinking =
		anthropicThinkingFromProviderFields(message?.providerFields) ?? [];
	blocks.push(...nativeThinking);
	if (nativeThinking.length === 0 && message?.reasoning) {
		blocks.push({
			type: "thinking",
			thinking: message.reasoning,
			signature: "",
		});
	}
	if (content) {
		blocks.push({ type: "text", text: content });
	}
	for (const tc of message?.toolCalls ?? []) {
		const providerSpecificFields = providerSpecificFieldsFromExtraContent(
			tc.extraContent,
		);
		blocks.push({
			type: "tool_use",
			// Thought signature embedded in the public id (LiteLLM-compatible round trip).
			id: encodeThoughtSignatureId(tc.id, tc.extraContent),
			name: tc.name,
			input: parseArgs(tc.arguments),
			...(providerSpecificFields === undefined
				? {}
				: { provider_specific_fields: providerSpecificFields }),
		});
	}
	return blocks;
}

/**
 * Carrier for other providers' message-bound state (Gemini signatures next to text, OpenAI
 * encrypted reasoning): a trailing `redacted_thinking` block, which Anthropic clients replay
 * verbatim and the gateway opens before any upstream sees it.
 */
function messageStateBlock(
	fields: Record<string, unknown> | undefined,
	opts: MessagesRenderOptions,
): Record<string, unknown> | undefined {
	const state = messageStateFromProviderFields(fields, ["google", "openai"]);
	return state === undefined || opts.messageState === undefined
		? undefined
		: { type: "redacted_thinking", data: opts.messageState.encode({}, state) };
}

export function canonicalToMessagesResponse(
	resp: CanonicalChatResponse,
	opts: MessagesRenderOptions,
): Record<string, unknown> {
	const [choice] = resp.choices;
	const blocks =
		nativeContent(choice?.message) ?? canonicalBlocks(choice?.message);
	const carrier = messageStateBlock(choice?.message.providerFields, opts);
	if (carrier !== undefined) {
		blocks.push(carrier);
	}
	return {
		id: messagesResponseId(resp.id),
		type: "message",
		role: "assistant",
		model: opts.publicModel,
		content: blocks,
		stop_reason: mapStopReason(
			choice?.finishReason ?? null,
			choice?.stopSequence,
			anthropicStopReasonFromProviderFields(choice?.message.providerFields),
		),
		stop_sequence: choice?.stopSequence ?? null,
		usage: usageToAnthropic(resp.usage),
	};
}

/* ---------------------------------------------- canonical stream -> SSE events */

function sse(type: string, payload: Record<string, unknown>): SSEEvent {
	return { event: type, data: JSON.stringify({ type, ...payload }) };
}

export async function* canonicalChunksToMessagesEvents(
	chunks: AsyncIterable<CanonicalChatStreamChunk>,
	opts: MessagesRenderOptions,
): AsyncGenerator<SSEEvent> {
	const id = `msg_${randomUUID()}`;
	let finalUsage: Usage | null = null;
	let finish: CanonicalFinishReason | null = null;
	let stopSequence: string | null = null;
	let nativeStopReason: string | undefined;

	let nextIndex = 0;
	let textOpen = false;
	let thinkingOpen = false;
	let textIndex = 0;
	let thinkingIndex = 0;
	const toolBlock = new Map<number, number>(); // canonical toolCall index -> anthropic block index
	// Anthropic stops each block before the next one starts; at most one is open at a time.
	let openTool: number | undefined;
	function* closeOpenBlocks(): Generator<SSEEvent> {
		if (thinkingOpen) {
			yield sse("content_block_stop", { index: thinkingIndex });
			thinkingOpen = false;
		}
		if (textOpen) {
			yield sse("content_block_stop", { index: textIndex });
			textOpen = false;
		}
		if (openTool !== undefined) {
			yield sse("content_block_stop", { index: openTool });
			openTool = undefined;
		}
	}
	// Other providers' message-bound state, sealed into one trailing block once the turn is done.
	let googleParts: Record<string, unknown>[] | undefined;
	const openaiReasoning: OpenAIReasoningStateItem[] = [];

	// Opened on the first chunk, so the usage Anthropic reports up front (input tokens) is known.
	let started = false;
	const messageStart = (initial: Usage | undefined): SSEEvent[] => [
		sse("message_start", {
			message: {
				id,
				type: "message",
				role: "assistant",
				model: opts.publicModel,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: initial
					? usageToAnthropic(initial)
					: {
							input_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							output_tokens: 0,
						},
			},
		}),
		// Anthropic emits a keep-alive ping after opening the stream.
		sse("ping", {}),
	];

	for await (const chunk of chunks) {
		if (!started) {
			started = true;
			yield* messageStart(chunk.initialUsage);
		}
		if (chunk.usage) {
			finalUsage = chunk.usage;
		}
		const [choice] = chunk.choices;
		if (!choice) {
			continue;
		}
		if (choice.finishReason) {
			finish = choice.finishReason;
		}
		if (choice.stopSequence !== undefined) {
			({ stopSequence } = choice);
		}
		const { delta } = choice;
		nativeStopReason =
			anthropicStopReasonFromProviderFields(delta.providerFields) ??
			nativeStopReason;
		const streamBlock = anthropicStreamBlockFromProviderFields(
			delta.providerFields,
		);
		if (streamBlock !== undefined) {
			// A server-tool call or result, where Anthropic streamed it.
			yield* closeOpenBlocks();
			const index = nextIndex++;
			const { input } = streamBlock;
			const streamedInput = "input" in streamBlock;
			yield sse("content_block_start", {
				index,
				content_block: streamedInput
					? { ...streamBlock, input: {} }
					: streamBlock,
			});
			if (streamedInput) {
				yield sse("content_block_delta", {
					index,
					delta: {
						type: "input_json_delta",
						partial_json: JSON.stringify(input ?? {}),
					},
				});
			}
			yield sse("content_block_stop", { index });
		}
		googleParts =
			googleContentPartsFromProviderFields(delta.providerFields) ?? googleParts;
		for (const item of openaiReasoningFromProviderFields(
			delta.providerFields,
		) ?? []) {
			if (
				item.id === undefined ||
				!openaiReasoning.some((existing) => existing.id === item.id)
			) {
				openaiReasoning.push(item);
			}
		}
		for (const block of anthropicThinkingFromProviderFields(
			delta.providerFields,
		) ?? []) {
			if (block.type === "thinking" && thinkingOpen) {
				if (block.signature.length > 0) {
					yield sse("content_block_delta", {
						index: thinkingIndex,
						delta: { type: "signature_delta", signature: block.signature },
					});
				}
				// The signature ends its block: thinking that follows is a block of its own.
				yield sse("content_block_stop", { index: thinkingIndex });
				thinkingOpen = false;
			} else if (block.type === "thinking") {
				// Thinking without visible text (display "omitted") streams no deltas; the signature
				// carries the reasoning and must still reach the client, in its place.
				yield* closeOpenBlocks();
				const index = nextIndex++;
				yield sse("content_block_start", {
					index,
					content_block: { type: "thinking", thinking: "", signature: "" },
				});
				if (block.thinking.length > 0) {
					yield sse("content_block_delta", {
						index,
						delta: { type: "thinking_delta", thinking: block.thinking },
					});
				}
				yield sse("content_block_delta", {
					index,
					delta: { type: "signature_delta", signature: block.signature },
				});
				yield sse("content_block_stop", { index });
			} else {
				yield* closeOpenBlocks();
				const index = nextIndex++;
				yield sse("content_block_start", {
					index,
					content_block: block,
				});
				yield sse("content_block_stop", { index });
			}
		}

		if (delta.reasoning) {
			if (!thinkingOpen) {
				yield* closeOpenBlocks();
				thinkingIndex = nextIndex++;
				thinkingOpen = true;
				yield sse("content_block_start", {
					index: thinkingIndex,
					content_block: { type: "thinking", thinking: "", signature: "" },
				});
			}
			yield sse("content_block_delta", {
				index: thinkingIndex,
				delta: { type: "thinking_delta", thinking: delta.reasoning },
			});
		}

		if (delta.content) {
			if (!textOpen) {
				yield* closeOpenBlocks();
				textIndex = nextIndex++;
				textOpen = true;
				yield sse("content_block_start", {
					index: textIndex,
					content_block: { type: "text", text: "" },
				});
			}
			yield sse("content_block_delta", {
				index: textIndex,
				delta: { type: "text_delta", text: delta.content },
			});
		}

		for (const tc of delta.toolCalls ?? []) {
			let blockIndex = toolBlock.get(tc.index);
			if (blockIndex === undefined) {
				yield* closeOpenBlocks();
				blockIndex = nextIndex++;
				toolBlock.set(tc.index, blockIndex);
				openTool = blockIndex;
				yield sse("content_block_start", {
					index: blockIndex,
					content_block: {
						type: "tool_use",
						id: encodeThoughtSignatureId(tc.id ?? "", tc.extraContent),
						name: tc.name ?? "",
						input: {},
						...(providerSpecificFieldsFromExtraContent(tc.extraContent) ===
						undefined
							? {}
							: {
									provider_specific_fields:
										providerSpecificFieldsFromExtraContent(tc.extraContent),
								}),
					},
				});
			}
			if (tc.arguments) {
				yield sse("content_block_delta", {
					index: blockIndex,
					delta: { type: "input_json_delta", partial_json: tc.arguments },
				});
			}
		}
	}

	if (!started) {
		yield* messageStart(undefined);
	}
	yield* closeOpenBlocks();
	const carrier = messageStateBlock(
		mergeProviderFields(
			googleParts === undefined
				? undefined
				: providerFieldsWithGoogleContentParts(googleParts),
			openaiReasoning.length === 0
				? undefined
				: providerFieldsWithOpenAIReasoning(openaiReasoning),
		),
		opts,
	);
	if (carrier !== undefined) {
		const index = nextIndex++;
		yield sse("content_block_start", { index, content_block: carrier });
		yield sse("content_block_stop", { index });
	}

	yield sse("message_delta", {
		delta: {
			stop_reason: mapStopReason(finish, stopSequence, nativeStopReason),
			stop_sequence: stopSequence,
		},
		// Cross-provider transports may learn input usage only at the end. Current Anthropic SDKs
		// accumulate every usage field present in message_delta, so report the complete final usage.
		usage: finalUsage ? usageToAnthropic(finalUsage) : { output_tokens: 0 },
	});
	yield sse("message_stop", {});
}
