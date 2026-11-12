import type { Usage } from "#core/usage.ts";
import { z } from "zod/v4";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type CanonicalDecisionAnswer,
	type DecisionMediaSource,
	type DecisionContentPart,
	type DecisionImageDetail,
	type DecisionQuestion,
	flattenDecisionInput,
	upstreamQuestionKeys,
	binaryConfidence,
	maxProbability,
	mergeTextParts,
	scoreLevelText,
	requireAnswer,
	partsAsText,
	optionKey,
} from "#core/decisions.ts";

/**
 * Gemini `POST /v1beta/decisions`: the public contract (request in, response out) and the transport
 * toward Google (request out, response in). Questions and answers are maps keyed by question name.
 */

export const GEMINI_QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

const resolutionSchema = z.enum(["low", "medium", "high", "ultra_high"]);

const mediaFields = {
	data: z.string().min(1).optional(),
	uri: z.string().min(1).optional(),
	mime_type: z.string().min(1).optional(),
};

function exactlyOneSource(
	value: { data?: string | undefined; uri?: string | undefined },
	ctx: z.RefinementCtx,
) {
	if ((value.data === undefined) === (value.uri === undefined)) {
		ctx.addIssue({
			code: "custom",
			message: "Set exactly one of `data` or `uri`",
		});
	}
}

const textBlockSchema = z
	.object({
		type: z.literal("text"),
		text: z.string(),
		annotations: z.array(z.unknown()).optional(),
	})
	.strict();

const inputBlockSchema = z.discriminatedUnion("type", [
	textBlockSchema,
	z
		.object({
			type: z.literal("image"),
			...mediaFields,
			resolution: resolutionSchema.optional(),
		})
		.strict()
		.superRefine(exactlyOneSource),
	z
		.object({
			type: z.literal("audio"),
			...mediaFields,
			channels: z.int().positive().optional(),
			sample_rate: z.int().positive().optional(),
		})
		.strict()
		.superRefine(exactlyOneSource),
	z
		.object({
			type: z.literal("video"),
			...mediaFields,
			resolution: resolutionSchema.optional(),
			processing: z.unknown().optional(),
			name: z.string().optional(),
		})
		.strict()
		.superRefine(exactlyOneSource),
	z
		.object({ type: z.literal("document"), ...mediaFields })
		.strict()
		.superRefine(exactlyOneSource),
]);

const instructionsSchema = z.union([
	z.string().min(1),
	textBlockSchema,
	z.array(textBlockSchema).min(1),
]);

const optionKeySchema = z
	.string()
	.min(1)
	.max(128)
	.refine((key) => key === key.trim(), {
		message: "must not start or end with a space",
	});

const questionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("noul"),
			instructions: instructionsSchema,
			criteria: z
				.object({
					true_description: z.string().optional(),
					false_description: z.string().optional(),
				})
				.strict()
				.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("choice"),
			instructions: instructionsSchema,
			criteria: z.record(optionKeySchema, z.string()).refine(
				(criteria) => {
					const count = Object.keys(criteria).length;
					return count >= 2 && count <= 255;
				},
				{ message: "must have between 2 and 255 options" },
			),
		})
		.strict(),
	z
		.object({
			type: z.literal("score"),
			instructions: instructionsSchema,
			criteria: z.array(z.string().min(1)).min(2).max(255),
		})
		.strict(),
]);

export const geminiDecisionRequestSchema = z
	.object({
		model: z.string().min(1),
		input: z.union([
			z.string().min(1),
			inputBlockSchema,
			z.array(inputBlockSchema).min(1),
		]),
		questions: z
			.record(
				z.string().regex(GEMINI_QUESTION_KEY, {
					message: "question keys are 1-64 characters of A-Z, a-z, 0-9, _ or -",
				}),
				questionSchema,
			)
			.refine(
				(questions) => {
					const count = Object.keys(questions).length;
					return count >= 1 && count <= 1000;
				},
				{ message: "must have between 1 and 1000 questions" },
			),
	})
	.strict();

export type GeminiDecisionRequest = z.infer<typeof geminiDecisionRequestSchema>;
type InputBlock = z.infer<typeof inputBlockSchema>;
type Question = z.infer<typeof questionSchema>;

/** Gemini models address a model as `models/<id>`; the gateway's public names never carry it. */
function stripModelsPrefix(model: string): string {
	return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function blockSource(block: {
	data?: string | undefined;
	uri?: string | undefined;
	mime_type?: string | undefined;
}): DecisionMediaSource {
	if (block.data !== undefined) {
		return {
			kind: "data",
			data: block.data,
			mimeType: block.mime_type ?? "application/octet-stream",
		};
	}
	return {
		kind: "url",
		url: block.uri ?? "",
		...(block.mime_type ? { mimeType: block.mime_type } : {}),
	};
}

function blockToPart(block: InputBlock): DecisionContentPart {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return {
				type: "image",
				source: blockSource(block),
				...(block.resolution ? { detail: block.resolution } : {}),
			};
		default:
			return { type: block.type, source: blockSource(block) };
	}
}

function instructionsToParts(
	instructions: z.infer<typeof instructionsSchema>,
): DecisionContentPart[] {
	if (typeof instructions === "string") {
		return [{ type: "text", text: instructions }];
	}
	const blocks = Array.isArray(instructions) ? instructions : [instructions];
	return blocks.map((block) => ({ type: "text", text: block.text }));
}

function questionToCanonical(
	key: string,
	question: Question,
): DecisionQuestion {
	const base = {
		key,
		instructions: instructionsToParts(question.instructions),
	};
	switch (question.type) {
		case "noul": {
			const { criteria } = question;
			const yes = criteria?.true_description;
			const no = criteria?.false_description;
			return {
				...base,
				kind: "binary",
				...(yes || no
					? {
							criteria: {
								...(yes
									? { true: [{ type: "text" as const, text: yes }] }
									: {}),
								...(no ? { false: [{ type: "text" as const, text: no }] } : {}),
							},
						}
					: {}),
			};
		}
		case "choice":
			return {
				...base,
				kind: "choice",
				options: Object.entries(question.criteria).map(
					([value, description]) => ({
						value,
						...(description
							? { description: [{ type: "text", text: description }] }
							: {}),
					}),
				),
			};
		default:
			return {
				...base,
				kind: "score",
				levels: question.criteria.map((description) => ({
					description: [{ type: "text", text: description }],
				})),
			};
	}
}

function inputBlocks(input: GeminiDecisionRequest["input"]): InputBlock[] {
	if (typeof input === "string") {
		return [{ type: "text", text: input }];
	}
	return Array.isArray(input) ? input : [input];
}

export function geminiDecisionRequestToCanonical(
	request: GeminiDecisionRequest,
): CanonicalDecisionRequest {
	const blocks = inputBlocks(request.input);
	return {
		model: stripModelsPrefix(request.model),
		input: [
			{ type: "message", role: "user", content: blocks.map(blockToPart) },
		],
		questions: Object.entries(request.questions).map(([key, question]) =>
			questionToCanonical(key, question),
		),
	};
}

function choiceProbabilities(
	question: Extract<DecisionQuestion, { kind: "choice" }>,
	probabilities: readonly number[],
): Record<string, number> {
	return Object.fromEntries(
		question.options.map((option, index) => [
			optionKey(option.value),
			probabilities[index] ?? 0,
		]),
	);
}

function levelMap<T>(
	levels: readonly unknown[],
	value: (index: number) => T,
): Record<string, T> {
	return Object.fromEntries(
		levels.map((_, index) => [String(index), value(index)]),
	);
}

/** One answer in Gemini's shape, or `undefined` for an answer Gemini cannot express (a refusal). */
export function renderGeminiAnswer(
	question: DecisionQuestion,
	answer: CanonicalDecisionAnswer,
): Record<string, unknown> | undefined {
	switch (answer.kind) {
		case "binary":
			return {
				type: "noul",
				noul: answer.probability,
				confidence: answer.confidence ?? binaryConfidence(answer.probability),
			};
		case "choice": {
			if (question.kind !== "choice") {
				return undefined;
			}
			const chosen = question.options[answer.choice];
			return {
				type: "choice",
				choice: chosen === undefined ? undefined : optionKey(chosen.value),
				probabilities: choiceProbabilities(question, answer.probabilities),
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
			};
		}
		case "score": {
			if (question.kind !== "score") {
				return undefined;
			}
			return {
				type: "score",
				score: answer.score,
				legend: levelMap(question.levels, (index) =>
					scoreLevelText(question.levels[index] ?? {}),
				),
				probabilities: levelMap(
					question.levels,
					(index) => answer.probabilities[index] ?? 0,
				),
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
			};
		}
		default:
			return undefined;
	}
}

function geminiUsage(usage: Usage | undefined): Record<string, unknown> {
	const input = usage?.promptTokens ?? 0;
	const reasoning = usage?.reasoningTokens ?? 0;
	const output = Math.max(0, (usage?.completionTokens ?? 0) - reasoning);
	return {
		total_input_tokens: input,
		total_cached_tokens: usage?.cacheReadTokens ?? 0,
		total_output_tokens: output,
		total_thought_tokens: reasoning,
		total_tokens: usage?.totalTokens ?? input + output + reasoning,
	};
}

/**
 * Gemini has no per-question refusal: a refused question is left out of `answers`, and when every
 * question was refused the input counts as blocked.
 */
export function toGeminiDecisionResponse(
	request: CanonicalDecisionRequest,
	response: CanonicalDecisionResponse,
): Record<string, unknown> {
	const answers: Record<string, unknown> = {};
	for (const [index, question] of request.questions.entries()) {
		const answer = response.answers[index];
		const rendered = answer ? renderGeminiAnswer(question, answer) : undefined;
		if (rendered && question.key !== null) {
			answers[question.key] = rendered;
		}
	}
	const blocked =
		response.blocked ??
		(Object.keys(answers).length === 0 && request.questions.length > 0
			? { reason: "other" }
			: undefined);
	return {
		answers,
		usage: geminiUsage(response.usage),
		...(blocked
			? {
					prompt_feedback: {
						block_reason: blocked.reason,
						...(blocked.message
							? { block_reason_message: blocked.message }
							: {}),
					},
				}
			: {}),
	};
}

// ---------------------------------------------------------------------------------------------
// Transport toward Google.

const EXTENSION_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	heic: "image/heic",
	heif: "image/heif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	wav: "audio/wav",
	mp3: "audio/mp3",
	flac: "audio/flac",
	ogg: "audio/ogg",
	m4a: "audio/m4a",
	aac: "audio/aac",
	opus: "audio/opus",
	mp4: "video/mp4",
	mov: "video/mov",
	webm: "video/webm",
	mpeg: "video/mpeg",
	avi: "video/avi",
	pdf: "application/pdf",
};

function mimeFromUrl(url: string): string | undefined {
	const match = /\.([a-z0-9]+)(?:[?#].*)?$/iu.exec(url);
	return match?.[1] ? EXTENSION_MIME[match[1].toLowerCase()] : undefined;
}

function geminiResolution(
	detail: DecisionImageDetail | undefined,
): z.infer<typeof resolutionSchema> | undefined {
	switch (detail) {
		case undefined:
		case "auto":
			return undefined;
		case "original":
			return "ultra_high";
		default:
			return detail;
	}
}

function mediaBlock(source: DecisionMediaSource): Record<string, unknown> {
	if (source.kind === "data") {
		return { data: source.data, mime_type: source.mimeType };
	}
	const mimeType = source.mimeType ?? mimeFromUrl(source.url);
	return { uri: source.url, ...(mimeType ? { mime_type: mimeType } : {}) };
}

function partToBlock(part: DecisionContentPart): Record<string, unknown> {
	switch (part.type) {
		case "text":
			return { type: "text", text: part.text };
		case "json":
			return { type: "text", text: JSON.stringify(part.data) };
		case "image": {
			const resolution = geminiResolution(part.detail);
			return {
				type: "image",
				...mediaBlock(part.source),
				...(resolution ? { resolution } : {}),
			};
		}
		default:
			return { type: part.type, ...mediaBlock(part.source) };
	}
}

function criteriaText(
	parts: DecisionContentPart[] | undefined,
): string | undefined {
	return parts ? partsAsText(parts) : undefined;
}

function questionToGemini(question: DecisionQuestion): Record<string, unknown> {
	const instructions = partsAsText(question.instructions);
	switch (question.kind) {
		case "binary": {
			const yes = criteriaText(question.criteria?.true);
			const no = criteriaText(question.criteria?.false);
			return {
				type: "noul",
				instructions,
				...(yes || no
					? {
							criteria: {
								...(yes ? { true_description: yes } : {}),
								...(no ? { false_description: no } : {}),
							},
						}
					: {}),
			};
		}
		case "choice":
			return {
				type: "choice",
				instructions,
				criteria: Object.fromEntries(
					question.options.map((option) => [
						optionKey(option.value),
						criteriaText(option.description) ?? "",
					]),
				),
			};
		case "score":
			return {
				type: "score",
				instructions,
				criteria: question.levels.map(scoreLevelText),
			};
		default:
			throw new TypeError("Gemini decisions have no box questions");
	}
}

export function buildGeminiDecisionBody(
	req: CanonicalDecisionRequest,
	upstreamModel: string,
): Record<string, unknown> {
	const parts = mergeTextParts(flattenDecisionInput(req.input));
	const [only] = parts;
	const keys = upstreamQuestionKeys(req.questions);
	return {
		model: stripModelsPrefix(upstreamModel),
		input:
			parts.length === 1 && only?.type === "text"
				? only.text
				: parts.map(partToBlock),
		questions: Object.fromEntries(
			req.questions.map((question, index) => [
				keys[index],
				questionToGemini(question),
			]),
		),
	};
}

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

function answerFromGemini(
	question: DecisionQuestion,
	raw: unknown,
): CanonicalDecisionAnswer | undefined {
	const value = record(raw);
	const confidence = number(value?.confidence);
	const withConfidence = confidence === undefined ? {} : { confidence };
	if (value?.type === "noul" && question.kind === "binary") {
		return {
			kind: "binary",
			probability: number(value.noul) ?? Number.NaN,
			...withConfidence,
		};
	}
	if (value?.type === "choice" && question.kind === "choice") {
		const probabilities = record(value.probabilities) ?? {};
		const keys = question.options.map((option) => optionKey(option.value));
		return {
			kind: "choice",
			choice: keys.indexOf(String(value.choice)),
			probabilities: keys.map((key) => number(probabilities[key]) ?? 0),
			...withConfidence,
		};
	}
	if (value?.type === "score" && question.kind === "score") {
		const probabilities = record(value.probabilities) ?? {};
		return {
			kind: "score",
			score: number(value.score) ?? Number.NaN,
			probabilities: question.levels.map(
				(_, index) => number(probabilities[String(index)]) ?? 0,
			),
			...withConfidence,
		};
	}
	return undefined;
}

function modalityTokens(raw: unknown, modality: string): number | undefined {
	if (!Array.isArray(raw)) {
		return undefined;
	}
	const row = raw.map(record).find((entry) => entry?.modality === modality);
	return number(row?.tokens);
}

export function geminiDecisionUsage(raw: unknown): Usage | undefined {
	const usage = record(raw);
	if (!usage) {
		return undefined;
	}
	const input = number(usage.total_input_tokens) ?? 0;
	const thought = number(usage.total_thought_tokens) ?? 0;
	const output = (number(usage.total_output_tokens) ?? 0) + thought;
	const cached = number(usage.total_cached_tokens);
	const byModality = usage.input_tokens_by_modality;
	// Video frames and PDF pages count as image tokens.
	const image =
		(modalityTokens(byModality, "image") ?? 0) +
		(modalityTokens(byModality, "video") ?? 0) +
		(modalityTokens(byModality, "document") ?? 0);
	const audio = modalityTokens(byModality, "audio");
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		...(cached ? { cacheReadTokens: cached } : {}),
		...(thought ? { reasoningTokens: thought } : {}),
		...(image ? { promptImageTokens: image } : {}),
		...(audio ? { promptAudioTokens: audio } : {}),
	};
}

export function parseGeminiDecisionResponse(
	raw: unknown,
	req: CanonicalDecisionRequest,
): CanonicalDecisionResponse {
	const value = record(raw);
	const answers = record(value?.answers) ?? {};
	const feedback = record(value?.prompt_feedback);
	const usage = geminiDecisionUsage(value?.usage);
	const usageField = usage ? { usage } : {};
	const reason = feedback?.block_reason;
	if (typeof reason === "string") {
		const message = feedback?.block_reason_message;
		return {
			answers: req.questions.map(() => ({ kind: "refusal" })),
			blocked: {
				reason,
				...(typeof message === "string" ? { message } : {}),
			},
			...usageField,
		};
	}
	const keys = upstreamQuestionKeys(req.questions);
	return {
		answers: req.questions.map((question, index) =>
			requireAnswer(
				answerFromGemini(question, answers[keys[index] ?? ""]),
				index,
			),
		),
		...usageField,
	};
}
