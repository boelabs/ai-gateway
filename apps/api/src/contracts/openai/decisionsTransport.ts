import { partsToOpenAI } from "./decisions.ts";
import type { Usage } from "#core/usage.ts";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type CanonicalDecisionAnswer,
	type DecisionContentPart,
	type DecisionInputItem,
	type DecisionQuestion,
	requireAnswer,
	partsAsText,
	flattenDecisionInput,
	mergeTextParts,
} from "#core/decisions.ts";

/** Canonical decisions to OpenAI `POST /decisions` and back. */

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function textOnly(
	parts: readonly DecisionContentPart[],
): string | Record<string, unknown>[] {
	const [only] = parts;
	return parts.length === 1 && only?.type === "text"
		? only.text
		: partsToOpenAI(parts);
}

function itemToOpenAI(item: DecisionInputItem): Record<string, unknown> {
	switch (item.type) {
		case "message":
			if (item.role === "assistant") {
				return {
					type: "message",
					role: "assistant",
					content: partsAsText(item.content),
				};
			}
			if (item.role === "user") {
				return {
					type: "message",
					role: "user",
					content: textOnly(item.content),
				};
			}
			return {
				type: "message",
				role: item.role,
				// Developer and system messages take text parts only.
				content: partsAsText(item.content),
			};
		case "tool_call":
			return item.tool === "function"
				? {
						type: "function_call",
						call_id: item.callId,
						name: item.name,
						arguments: item.input,
					}
				: {
						type: "custom_tool_call",
						call_id: item.callId,
						name: item.name,
						input: item.input,
					};
		default:
			return {
				type:
					item.tool === "function"
						? "function_call_output"
						: "custom_tool_call_output",
				call_id: item.callId,
				output: textOnly(item.output),
			};
	}
}

/** Predicate criteria have no OpenAI field; they become part of the instructions. */
function predicateInstructions(
	question: Extract<DecisionQuestion, { kind: "binary" }>,
): DecisionContentPart[] {
	const { criteria } = question;
	if (!(criteria?.true || criteria?.false)) {
		return question.instructions;
	}
	return [
		...question.instructions,
		...(criteria.true
			? [{ type: "text" as const, text: "\nTrue when: " }, ...criteria.true]
			: []),
		...(criteria.false
			? [{ type: "text" as const, text: "\nFalse when: " }, ...criteria.false]
			: []),
	];
}

function questionToOpenAI(
	question: DecisionQuestion,
	name: string,
): Record<string, unknown> {
	switch (question.kind) {
		case "binary":
			return {
				type: "predicate",
				name,
				instructions: textOnly(predicateInstructions(question)),
			};
		case "choice":
			return {
				type: "choice",
				name,
				instructions: textOnly(question.instructions),
				choices: question.options.map((option) => ({
					value: option.value,
					...(option.description
						? { description: partsAsText(option.description) }
						: {}),
				})),
			};
		case "score":
			return {
				type: "score",
				name,
				instructions: textOnly(question.instructions),
				levels: question.levels.map((level, index) => ({
					label: level.label ?? String(index),
					...(level.description
						? { description: partsAsText(level.description) }
						: {}),
				})),
			};
		default:
			throw new TypeError("OpenAI decisions have no box questions");
	}
}

/**
 * Questions are sent named by position so answers map back without trusting the upstream's names.
 */
/**
 * `openai` is OpenAI's own API. `azure` is Azure OpenAI's `/openai/v1/decisions`, which documents only
 * user messages of text and images and none of the caching or end-user fields, so the input is folded
 * into one labeled user message and those fields are left out.
 */
export type OpenAIDecisionDialect = "openai" | "azure";

function azureInput(req: CanonicalDecisionRequest): Record<string, unknown>[] {
	const parts = mergeTextParts(
		flattenDecisionInput(req.input).map((part) =>
			part.type === "json"
				? { type: "text" as const, text: JSON.stringify(part.data) }
				: part,
		),
	);
	return [{ type: "message", role: "user", content: textOnly(parts) }];
}

export function buildOpenAIDecisionBody(
	req: CanonicalDecisionRequest,
	upstreamModel: string,
	dialect: OpenAIDecisionDialect = "openai",
): Record<string, unknown> {
	const questions = req.questions.map((question, index) =>
		questionToOpenAI(question, `q${index}`),
	);
	if (dialect === "azure") {
		return { model: upstreamModel, input: azureInput(req), questions };
	}
	const cache = req.promptCache;
	return {
		model: upstreamModel,
		input: req.input.map(itemToOpenAI),
		questions,
		...(cache?.key ? { prompt_cache_key: cache.key } : {}),
		...(cache?.mode || cache?.ttl
			? {
					prompt_cache_options: {
						...(cache.mode ? { mode: cache.mode } : {}),
						...(cache.ttl ? { ttl: cache.ttl } : {}),
					},
				}
			: {}),
		...(req.user ? { safety_identifier: req.user } : {}),
	};
}

function choiceAnswer(
	question: Extract<DecisionQuestion, { kind: "choice" }>,
	value: Record<string, unknown>,
): CanonicalDecisionAnswer {
	const probabilities = question.options.map(() => 0);
	const rows = Array.isArray(value.probabilities) ? value.probabilities : [];
	for (const row of rows) {
		const entry = record(row);
		const index = question.options.findIndex(
			(option) => option.value === entry?.value,
		);
		if (index >= 0) {
			probabilities[index] = number(entry?.probability) ?? 0;
		}
	}
	const confidence = number(value.confidence);
	return {
		kind: "choice",
		choice: question.options.findIndex(
			(option) => option.value === value.choice,
		),
		probabilities,
		...(confidence === undefined ? {} : { confidence }),
	};
}

function scoreAnswer(
	question: Extract<DecisionQuestion, { kind: "score" }>,
	value: Record<string, unknown>,
): CanonicalDecisionAnswer {
	const probabilities = question.levels.map(() => 0);
	const rows = Array.isArray(value.probabilities) ? value.probabilities : [];
	for (const row of rows) {
		const entry = record(row);
		const index = number(entry?.value);
		if (index !== undefined && index >= 0 && index < probabilities.length) {
			probabilities[index] = number(entry?.probability) ?? 0;
		}
	}
	const confidence = number(value.confidence);
	return {
		kind: "score",
		score: number(value.score) ?? Number.NaN,
		probabilities,
		...(confidence === undefined ? {} : { confidence }),
	};
}

function answerFromOpenAI(
	question: DecisionQuestion,
	raw: unknown,
): CanonicalDecisionAnswer | undefined {
	const value = record(raw);
	switch (value?.type) {
		case "refusal":
			return { kind: "refusal" };
		case "predicate":
			return question.kind === "binary"
				? {
						kind: "binary",
						probability: number(value.probability) ?? Number.NaN,
					}
				: undefined;
		case "choice":
			return question.kind === "choice"
				? choiceAnswer(question, value)
				: undefined;
		case "score":
			return question.kind === "score"
				? scoreAnswer(question, value)
				: undefined;
		default:
			return undefined;
	}
}

export function openAIDecisionUsage(raw: unknown): Usage | undefined {
	const usage = record(raw);
	if (!usage) {
		return undefined;
	}
	const input = number(usage.input_tokens) ?? 0;
	const output = number(usage.output_tokens) ?? 0;
	const inputDetails = record(usage.input_tokens_details);
	const outputDetails = record(usage.output_tokens_details);
	const cached = number(inputDetails?.cached_tokens);
	const cacheWrite = number(inputDetails?.cache_write_tokens);
	const reasoning = number(outputDetails?.reasoning_tokens);
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		...(cached ? { cacheReadTokens: cached } : {}),
		...(cacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
		...(reasoning ? { reasoningTokens: reasoning } : {}),
	};
}

/**
 * OpenAI answers come back in question order. A name we sent (`q<index>`) locates the answer when
 * present; otherwise the position does.
 */
export function parseOpenAIDecisionResponse(
	raw: unknown,
	req: CanonicalDecisionRequest,
): CanonicalDecisionResponse {
	const value = record(raw);
	const rawAnswers = Array.isArray(value?.answers) ? value.answers : [];
	const byName = new Map<string, unknown>();
	for (const answer of rawAnswers) {
		const name = record(answer)?.name;
		if (typeof name === "string") {
			byName.set(name, answer);
		}
	}
	const usage = openAIDecisionUsage(value?.usage);
	return {
		...(typeof value?.id === "string" ? { id: value.id } : {}),
		...(typeof value?.model === "string" ? { model: value.model } : {}),
		answers: req.questions.map((question, index) => {
			const answer = byName.get(`q${index}`) ?? rawAnswers[index];
			return requireAnswer(answerFromOpenAI(question, answer), index);
		}),
		...(usage ? { usage } : {}),
	};
}
