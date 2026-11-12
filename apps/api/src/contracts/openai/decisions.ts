import { z } from "zod/v4";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type CanonicalDecisionAnswer,
	type DecisionContentPart,
	type DecisionInputItem,
	type DecisionQuestion,
	maxProbability,
	partsAreTextual,
	parseDataUrl,
	partsAsText,
	sourceAsUrl,
} from "#core/decisions.ts";

/** OpenAI `POST /v1/decisions`: questions are a list, answers come back in the same order. */

const cacheBreakpointSchema = z
	.object({ mode: z.literal("explicit") })
	.strict();

const inputTextSchema = z
	.object({
		type: z.literal("input_text"),
		text: z.string(),
		prompt_cache_breakpoint: cacheBreakpointSchema.nullable().optional(),
	})
	.strict();

const inputImageSchema = z
	.object({
		type: z.literal("input_image"),
		image_url: z.string().min(1),
		detail: z.enum(["low", "high", "auto", "original"]).nullable().optional(),
		prompt_cache_breakpoint: cacheBreakpointSchema.nullable().optional(),
	})
	.strict();

const jsonObjectSchema = z.record(z.string(), z.unknown());

const inputJsonSchema = z
	.object({
		type: z.literal("input_json"),
		data: z.union([jsonObjectSchema, z.array(jsonObjectSchema)]),
	})
	.strict();

const userPartSchema = z.discriminatedUnion("type", [
	inputTextSchema,
	inputImageSchema,
	inputJsonSchema,
]);
const toolOutputPartSchema = z.discriminatedUnion("type", [
	inputTextSchema,
	inputImageSchema,
]);

const messageType = z.literal("message").optional();
const itemStatus = z
	.enum(["in_progress", "completed", "incomplete"])
	.nullable()
	.optional();

const inputItemSchema = z.union([
	z
		.object({
			type: messageType,
			role: z.literal("user"),
			content: z.union([z.string(), z.array(userPartSchema)]),
		})
		.strict(),
	z
		.object({
			type: messageType,
			role: z.enum(["developer", "system"]),
			content: z.union([z.string(), z.array(inputTextSchema)]),
		})
		.strict(),
	z
		.object({
			type: messageType,
			role: z.literal("assistant"),
			content: z.union([
				z.string(),
				z.array(
					z.discriminatedUnion("type", [
						z
							.object({ type: z.literal("output_text"), text: z.string() })
							.strict(),
						z
							.object({ type: z.literal("refusal"), refusal: z.string() })
							.strict(),
					]),
				),
			]),
			phase: z.enum(["commentary", "final_answer"]).nullable().optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("function_call"),
			call_id: z.string().min(1),
			name: z.string().min(1),
			arguments: z.string(),
			id: z.string().nullable().optional(),
			namespace: z.string().nullable().optional(),
			status: itemStatus,
		})
		.strict(),
	z
		.object({
			type: z.literal("function_call_output"),
			call_id: z.string().min(1),
			output: z.union([z.string(), z.array(toolOutputPartSchema)]),
			id: z.string().nullable().optional(),
			status: itemStatus,
		})
		.strict(),
	z
		.object({
			type: z.literal("custom_tool_call"),
			call_id: z.string().min(1),
			name: z.string().min(1),
			input: z.string(),
			id: z.string().nullable().optional(),
			namespace: z.string().nullable().optional(),
			status: itemStatus,
		})
		.strict(),
	z
		.object({
			type: z.literal("custom_tool_call_output"),
			call_id: z.string().min(1),
			output: z.union([z.string(), z.array(toolOutputPartSchema)]),
			id: z.string().nullable().optional(),
			status: itemStatus,
		})
		.strict(),
]);

const instructionsSchema = z.union([
	z.string().min(1),
	z.array(userPartSchema).min(1),
]);

const questionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("predicate"),
			instructions: instructionsSchema,
			name: z.string().optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("choice"),
			instructions: instructionsSchema,
			name: z.string().optional(),
			choices: z
				.array(
					z
						.object({
							value: z.union([z.string().min(1), z.boolean()]),
							description: z.string().optional(),
						})
						.strict(),
				)
				.min(2)
				.max(255),
		})
		.strict(),
	z
		.object({
			type: z.literal("score"),
			instructions: instructionsSchema,
			name: z.string().optional(),
			levels: z
				.array(
					z
						.object({
							label: z.string().min(1),
							description: z.string().optional(),
						})
						.strict(),
				)
				.min(2),
		})
		.strict(),
]);

export const openAIDecisionRequestSchema = z
	.object({
		model: z.string().min(1),
		input: z.union([z.string().min(1), z.array(inputItemSchema).min(1)]),
		questions: z.array(questionSchema).min(1).max(400),
		prompt_cache_key: z.string().nullable().optional(),
		prompt_cache_options: z
			.object({
				mode: z.enum(["implicit", "explicit"]).nullable().optional(),
				ttl: z.string().optional(),
			})
			.strict()
			.nullable()
			.optional(),
		safety_identifier: z.string().nullable().optional(),
	})
	.strict()
	.superRefine((request, ctx) => {
		for (const [index, question] of request.questions.entries()) {
			if (question.type !== "choice") {
				continue;
			}
			const seen = new Set<string>();
			for (const choice of question.choices) {
				const key = `${typeof choice.value}:${choice.value}`;
				if (seen.has(key)) {
					ctx.addIssue({
						code: "custom",
						path: ["questions", index, "choices"],
						message: `Duplicate choice value ${JSON.stringify(choice.value)}`,
					});
				}
				seen.add(key);
			}
		}
	});

export type OpenAIDecisionRequest = z.infer<typeof openAIDecisionRequestSchema>;
type UserPart = z.infer<typeof userPartSchema>;
type InputItem = z.infer<typeof inputItemSchema>;
type Question = z.infer<typeof questionSchema>;

function imagePart(
	part: z.infer<typeof inputImageSchema>,
): DecisionContentPart {
	const data = parseDataUrl(part.image_url);
	return {
		type: "image",
		source: data
			? { kind: "data", data: data.data, mimeType: data.mimeType }
			: { kind: "url", url: part.image_url },
		...(part.detail ? { detail: part.detail } : {}),
		...(part.prompt_cache_breakpoint ? { cacheBreakpoint: true } : {}),
	};
}

function partToCanonical(part: UserPart): DecisionContentPart {
	switch (part.type) {
		case "input_text":
			return {
				type: "text",
				text: part.text,
				...(part.prompt_cache_breakpoint ? { cacheBreakpoint: true } : {}),
			};
		case "input_image":
			return imagePart(part);
		default:
			return { type: "json", data: part.data };
	}
}

function contentToCanonical(
	content: string | readonly UserPart[],
): DecisionContentPart[] {
	return typeof content === "string"
		? [{ type: "text", text: content }]
		: content.map(partToCanonical);
}

function itemToCanonical(item: InputItem): DecisionInputItem {
	if (!("role" in item)) {
		switch (item.type) {
			case "function_call":
				return {
					type: "tool_call",
					tool: "function",
					callId: item.call_id,
					name: item.name,
					input: item.arguments,
				};
			case "custom_tool_call":
				return {
					type: "tool_call",
					tool: "custom",
					callId: item.call_id,
					name: item.name,
					input: item.input,
				};
			default:
				return {
					type: "tool_result",
					tool: item.type === "function_call_output" ? "function" : "custom",
					callId: item.call_id,
					output: contentToCanonical(item.output),
				};
		}
	}
	if (item.role === "assistant") {
		return {
			type: "message",
			role: "assistant",
			content:
				typeof item.content === "string"
					? [{ type: "text", text: item.content }]
					: item.content.map((part) => ({
							type: "text" as const,
							text: part.type === "output_text" ? part.text : part.refusal,
						})),
		};
	}
	return {
		type: "message",
		role: item.role,
		content: contentToCanonical(item.content),
	};
}

function questionToCanonical(question: Question): DecisionQuestion {
	const base = {
		key: question.name ?? null,
		instructions: contentToCanonical(question.instructions),
	};
	switch (question.type) {
		case "predicate":
			return { ...base, kind: "binary" };
		case "choice":
			return {
				...base,
				kind: "choice",
				options: question.choices.map((choice) => ({
					value: choice.value,
					...(choice.description === undefined
						? {}
						: { description: [{ type: "text", text: choice.description }] }),
				})),
			};
		default:
			return {
				...base,
				kind: "score",
				levels: question.levels.map((level) => ({
					label: level.label,
					...(level.description === undefined
						? {}
						: { description: [{ type: "text", text: level.description }] }),
				})),
			};
	}
}

export function openAIDecisionRequestToCanonical(
	request: OpenAIDecisionRequest,
): CanonicalDecisionRequest {
	const cacheMode = request.prompt_cache_options?.mode ?? undefined;
	const cacheTtl = request.prompt_cache_options?.ttl;
	const promptCache = {
		...(request.prompt_cache_key ? { key: request.prompt_cache_key } : {}),
		...(cacheMode ? { mode: cacheMode } : {}),
		...(cacheTtl ? { ttl: cacheTtl } : {}),
	};
	return {
		model: request.model,
		input:
			typeof request.input === "string"
				? [
						{
							type: "message",
							role: "user",
							content: [{ type: "text", text: request.input }],
						},
					]
				: request.input.map(itemToCanonical),
		questions: request.questions.map(questionToCanonical),
		...(Object.keys(promptCache).length > 0 ? { promptCache } : {}),
		...(request.safety_identifier ? { user: request.safety_identifier } : {}),
	};
}

/** OpenAI's wire form of canonical parts, shared by the contract and the OpenAI transport. */
export function partsToOpenAI(
	parts: readonly DecisionContentPart[],
): Record<string, unknown>[] {
	return parts.map((part) => {
		switch (part.type) {
			case "text":
				return {
					type: "input_text",
					text: part.text,
					...(part.cacheBreakpoint
						? { prompt_cache_breakpoint: { mode: "explicit" } }
						: {}),
				};
			case "json":
				return isJsonObjectOrList(part.data)
					? { type: "input_json", data: part.data }
					: { type: "input_text", text: JSON.stringify(part.data) };
			case "image":
				return {
					type: "input_image",
					image_url: sourceAsUrl(part.source),
					...(part.detail === undefined
						? {}
						: { detail: openAIImageDetail(part.detail) }),
					...(part.cacheBreakpoint
						? { prompt_cache_breakpoint: { mode: "explicit" } }
						: {}),
				};
			default:
				throw new TypeError(`OpenAI decisions cannot carry ${part.type} input`);
		}
	});
}

function isJsonObjectOrList(value: unknown): boolean {
	const isObject = (item: unknown) =>
		item !== null && typeof item === "object" && !Array.isArray(item);
	return isObject(value) || (Array.isArray(value) && value.every(isObject));
}

function openAIImageDetail(
	detail: NonNullable<
		Extract<DecisionContentPart, { type: "image" }>["detail"]
	>,
): "low" | "high" | "auto" | "original" {
	switch (detail) {
		case "medium":
			return "auto";
		case "ultra_high":
			return "original";
		default:
			return detail;
	}
}

/** Text a score level shows as its label when the client gave it none. */
export function scoreLevelLabel(
	level: { label?: string; description?: DecisionContentPart[] },
	index: number,
): string {
	if (level.label !== undefined) {
		return level.label;
	}
	if (level.description && partsAreTextual(level.description)) {
		return partsAsText(level.description);
	}
	return String(index);
}

function renderAnswer(
	question: DecisionQuestion,
	answer: CanonicalDecisionAnswer,
): Record<string, unknown> {
	const name = question.key;
	switch (answer.kind) {
		case "binary":
			return { type: "predicate", name, probability: answer.probability };
		case "choice": {
			const options = question.kind === "choice" ? question.options : [];
			return {
				type: "choice",
				name,
				choice: options[answer.choice]?.value,
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
				probabilities: options.map((option, index) => ({
					value: option.value,
					probability: answer.probabilities[index] ?? 0,
				})),
			};
		}
		case "score": {
			const levels = question.kind === "score" ? question.levels : [];
			return {
				type: "score",
				name,
				score: answer.score,
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
				probabilities: levels.map((level, index) => ({
					label: scoreLevelLabel(level, index),
					value: index,
					probability: answer.probabilities[index] ?? 0,
				})),
			};
		}
		default:
			// A box answer has no OpenAI form; it cannot be asked through this contract either.
			return { type: "refusal", name };
	}
}

export function toOpenAIDecisionResponse(
	request: CanonicalDecisionRequest,
	response: CanonicalDecisionResponse,
): Record<string, unknown> {
	const { usage } = response;
	return {
		model: request.model,
		answers: request.questions.map((question, index) =>
			renderAnswer(question, response.answers[index] ?? { kind: "refusal" }),
		),
		usage: {
			input_tokens: usage?.promptTokens ?? 0,
			input_tokens_details: {
				cached_tokens: usage?.cacheReadTokens ?? 0,
				cache_write_tokens: usage?.cacheWriteTokens ?? 0,
			},
			output_tokens: usage?.completionTokens ?? 0,
			output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
			total_tokens: usage?.totalTokens ?? 0,
		},
	};
}
