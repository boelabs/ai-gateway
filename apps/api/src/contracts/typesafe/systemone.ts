import { GatewayError } from "#core/errors.ts";
import type { Usage } from "#core/usage.ts";
import { createHash } from "node:crypto";
import { z } from "zod/v4";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type CanonicalDecisionAnswer,
	type DecisionContentPart,
	type DecisionQuestion,
	flattenDecisionInput,
	upstreamQuestionKeys,
	typeSafeImageFormat,
	type DecisionBox,
	maxProbability,
	mergeTextParts,
	scoreLevelText,
	requireAnswer,
	optionKey,
} from "#core/decisions.ts";

/**
 * TypeSafe `POST /v1/systemone` (Jev): the public contract and the transport toward TypeSafe and
 * OpenRouter's Decisions API, which takes the same body. `state`, `instructions` and `criteria` are
 * free JSON; images travel as `assets` and are referenced by name from inside that JSON.
 */

const jsonValue: z.ZodType<unknown> = z.unknown();
const content = jsonValue.refine((value) => value !== undefined);
const nullableContent = z.union([z.null(), content]);

const questionSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("noul"),
			instructions: nullableContent.optional(),
			criteria: z
				.object({
					true: nullableContent.optional(),
					false: nullableContent.optional(),
				})
				.strict()
				.nullable()
				.optional(),
		})
		.strict(),
	z
		.object({
			type: z.literal("choice"),
			instructions: nullableContent.optional(),
			criteria: z.record(z.string().min(1), nullableContent).refine(
				(criteria) => {
					const count = Object.keys(criteria).length;
					return count >= 1 && count <= 255;
				},
				{ message: "must have between 1 and 255 options" },
			),
		})
		.strict(),
	z
		.object({
			type: z.literal("score"),
			instructions: nullableContent.optional(),
			criteria: z
				.array(content.refine((value) => value !== null))
				.min(1)
				.max(10),
		})
		.strict(),
	z
		.object({
			type: z.literal("box"),
			instructions: nullableContent.optional(),
		})
		.strict(),
]);

const assetSchema = z
	.object({
		type: z.literal("image").optional(),
		format: z.enum(["png", "jpg", "jpeg"]).optional(),
		data_base64: z.string().min(1).optional(),
		part: z.string().min(1).optional(),
	})
	.strict()
	.refine(
		(asset) => asset.data_base64 !== undefined || asset.part !== undefined,
		{
			message: "an asset needs `data_base64` or a multipart `part`",
		},
	);

export const systemOneRequestSchema = z
	.object({
		model: z.string().min(1),
		state: content,
		questions: z
			.record(z.string().min(1), questionSchema)
			.refine((questions) => Object.keys(questions).length >= 1, {
				message: "must have at least one question",
			}),
		assets: z.record(z.string().min(1).max(1024), assetSchema).optional(),
	})
	.strict();

export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>;
type Question = z.infer<typeof questionSchema>;
type Asset = z.infer<typeof assetSchema>;

const MULTIPART_PARTS_MAX = 512;

function badRequest(message: string): GatewayError {
	return new GatewayError({
		class: "bad_request",
		message,
		publicMessage: message,
	});
}

/**
 * Parses a TypeSafe request sent as JSON or as `multipart/form-data` (a `request` JSON part, then one
 * part per image named by an asset's `part`). Multipart images are inlined as base64 assets.
 */
export async function parseSystemOneBody(
	contentType: string,
	bytes: Uint8Array,
): Promise<unknown> {
	const form = await new Response(bytes, {
		headers: { "content-type": contentType },
	})
		.formData()
		.catch(() => {
			throw badRequest("The multipart body could not be read");
		});
	const head = form.get("request");
	if (head === null) {
		throw badRequest(
			"A multipart request needs a `request` part with the JSON body",
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(typeof head === "string" ? head : await head.text());
	} catch {
		throw badRequest("The `request` part is not valid JSON");
	}
	const assets = (body as { assets?: Record<string, Asset> } | null)?.assets;
	if (!assets || typeof assets !== "object") {
		return body;
	}
	let parts = 0;
	for (const [ref, asset] of Object.entries(assets)) {
		if (asset?.part === undefined) {
			continue;
		}
		parts += 1;
		if (parts > MULTIPART_PARTS_MAX) {
			throw badRequest("Too many multipart image parts");
		}
		const file = form.get(asset.part);
		if (file === null || typeof file === "string") {
			throw badRequest(`No multipart part named "${asset.part}"`);
		}
		const data = new Uint8Array(await file.arrayBuffer());
		const { part: _part, ...rest } = asset;
		assets[ref] = {
			...rest,
			data_base64: Buffer.from(data).toString("base64"),
			format: asset.format ?? sniffImageFormat(data),
		};
	}
	return body;
}

export function isMultipart(contentType: string): boolean {
	return contentType.toLowerCase().startsWith("multipart/form-data");
}

function sniffImageFormat(bytes: Uint8Array): "png" | "jpg" | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
		return "png";
	}
	return bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : undefined;
}

interface AssetImage {
	ref: string;
	part: DecisionContentPart;
}

function assetImages(assets: SystemOneRequest["assets"]): AssetImage[] {
	return (
		Object.entries(assets ?? {})
			.map(([ref, asset]) => ({
				ref,
				part: {
					type: "image" as const,
					source: {
						kind: "data" as const,
						data: asset.data_base64 ?? "",
						mimeType: asset.format === "png" ? "image/png" : "image/jpeg",
					},
				},
			}))
			// Longest first, so a reference that contains a shorter one is matched whole.
			.sort((a, b) => b.ref.length - a.ref.length)
	);
}

/** A string with the asset references it contains replaced by their images, in place. */
function stringToParts(
	text: string,
	images: readonly AssetImage[],
): DecisionContentPart[] {
	for (const image of images) {
		const at = text.indexOf(image.ref);
		if (at >= 0) {
			return [
				...stringToParts(text.slice(0, at), images),
				image.part,
				...stringToParts(text.slice(at + image.ref.length), images),
			];
		}
	}
	return text === "" ? [] : [{ type: "text", text }];
}

function referencedImages(
	value: unknown,
	images: readonly AssetImage[],
): AssetImage[] {
	const found = new Set<AssetImage>();
	const visit = (node: unknown) => {
		if (typeof node === "string") {
			for (const image of images) {
				if (node.includes(image.ref)) {
					found.add(image);
				}
			}
		} else if (Array.isArray(node)) {
			node.forEach(visit);
		} else if (node !== null && typeof node === "object") {
			Object.values(node).forEach(visit);
		}
	};
	visit(value);
	return [...found];
}

/**
 * TypeSafe's free JSON as parts. Strings and lists keep their images in place; a structured value
 * stays JSON, with each image it references appended after it under its reference name.
 */
function jsonToParts(
	value: unknown,
	images: readonly AssetImage[],
): DecisionContentPart[] {
	if (value === null || value === undefined) {
		return [];
	}
	if (typeof value === "string") {
		return stringToParts(value, images);
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => jsonToParts(item, images));
	}
	return [
		{ type: "json", data: value },
		...referencedImages(value, images).flatMap(
			(image): DecisionContentPart[] => [
				{ type: "text", text: `\n${image.ref}: ` },
				image.part,
			],
		),
	];
}

function questionToCanonical(
	key: string,
	question: Question,
	images: readonly AssetImage[],
): DecisionQuestion {
	const base = {
		key,
		instructions: jsonToParts(question.instructions, images),
	};
	switch (question.type) {
		case "noul": {
			const yes = jsonToParts(question.criteria?.true, images);
			const no = jsonToParts(question.criteria?.false, images);
			return {
				...base,
				kind: "binary",
				...(yes.length > 0 || no.length > 0
					? {
							criteria: {
								...(yes.length > 0 ? { true: yes } : {}),
								...(no.length > 0 ? { false: no } : {}),
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
					([value, description]) => {
						const parts = jsonToParts(description, images);
						return {
							value,
							...(parts.length > 0 ? { description: parts } : {}),
						};
					},
				),
			};
		case "score":
			return {
				...base,
				kind: "score",
				levels: question.criteria.map((level) => ({
					description: jsonToParts(level, images),
				})),
			};
		default:
			return { ...base, kind: "box" };
	}
}

export function systemOneRequestToCanonical(
	request: SystemOneRequest,
): CanonicalDecisionRequest {
	const images = assetImages(request.assets);
	return {
		model: request.model,
		input: [
			{
				type: "message",
				role: "user",
				content: jsonToParts(request.state, images),
			},
		],
		questions: Object.entries(request.questions).map(([key, question]) =>
			questionToCanonical(key, question, images),
		),
	};
}

/** A score level as TypeSafe shows it in `legend`: its text, or its JSON when it was structured. */
function legendEntry(
	question: Extract<DecisionQuestion, { kind: "score" }>,
	index: number,
): unknown {
	const level = question.levels[index];
	const [only] = level?.description ?? [];
	if (
		level?.label === undefined &&
		level?.description?.length === 1 &&
		only?.type === "json"
	) {
		return only.data;
	}
	return level ? scoreLevelText(level) : "";
}

function renderAnswer(
	question: DecisionQuestion,
	answer: CanonicalDecisionAnswer,
): Record<string, unknown> {
	switch (answer.kind) {
		case "binary":
			return { type: "noul", noul: answer.probability };
		case "choice": {
			const options = question.kind === "choice" ? question.options : [];
			const chosen = options[answer.choice];
			return {
				type: "choice",
				choice: chosen === undefined ? undefined : optionKey(chosen.value),
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
				probabilities: Object.fromEntries(
					options.map((option, index) => [
						optionKey(option.value),
						answer.probabilities[index] ?? 0,
					]),
				),
			};
		}
		case "score": {
			if (question.kind !== "score") {
				return { type: "refusal" };
			}
			return {
				type: "score",
				score: answer.score,
				confidence: answer.confidence ?? maxProbability(answer.probabilities),
				legend: Object.fromEntries(
					question.levels.map((_, index) => [
						String(index),
						legendEntry(question, index),
					]),
				),
				probabilities: Object.fromEntries(
					question.levels.map((_, index) => [
						String(index),
						answer.probabilities[index] ?? 0,
					]),
				),
			};
		}
		case "box":
			return { type: "box", box: answer.box, confidence: answer.confidence };
		default:
			// OpenRouter's extension of the TypeSafe shape; TypeSafe itself never refuses.
			return { type: "refusal" };
	}
}

export function toSystemOneResponse(
	request: CanonicalDecisionRequest,
	response: CanonicalDecisionResponse,
): Record<string, unknown> {
	return {
		model: request.model,
		answers: Object.fromEntries(
			request.questions.map((question, index) => [
				question.key ?? `q${index}`,
				renderAnswer(question, response.answers[index] ?? { kind: "refusal" }),
			]),
		),
		usage: {
			input_tokens: response.usage?.promptTokens ?? 0,
			output_tokens: response.usage?.completionTokens ?? 0,
		},
	};
}

// ---------------------------------------------------------------------------------------------
// Transport toward TypeSafe and OpenRouter.

class AssetCollector {
	readonly assets: Record<string, Record<string, unknown>> = {};
	private count = 0;

	/** A reference no text is likely to contain by accident: TypeSafe matches references as plain text. */
	add(part: Extract<DecisionContentPart, { type: "image" }>): string {
		const { source } = part;
		if (source.kind !== "data") {
			throw badRequest(
				"Decisions on this provider take images as inline data, not URLs",
			);
		}
		const format = typeSafeImageFormat(source.mimeType);
		if (!format) {
			throw badRequest(
				`Decisions on this provider take PNG or JPEG images, not ${source.mimeType}`,
			);
		}
		const digest = createHash("sha256")
			.update(source.data)
			.digest("hex")
			.slice(0, 16);
		const ref = `asset-${this.count++}-${digest}`;
		this.assets[ref] = { type: "image", format, data_base64: source.data };
		return ref;
	}

	get size(): number {
		return this.count;
	}
}

/** Parts in TypeSafe's free JSON: one string or value when that is all there is, else a list. */
function encodeParts(
	parts: readonly DecisionContentPart[],
	assets: AssetCollector,
): unknown {
	const merged = mergeTextParts(parts);
	const encoded = merged.map((part) => {
		switch (part.type) {
			case "text":
				return part.text;
			case "json":
				return part.data;
			case "image":
				return assets.add(part);
			default:
				throw badRequest(
					`Decisions on this provider cannot take ${part.type} input`,
				);
		}
	});
	return encoded.length === 1 ? encoded[0] : encoded;
}

function encodeScoreLevel(
	level: Extract<DecisionQuestion, { kind: "score" }>["levels"][number],
	assets: AssetCollector,
): unknown {
	const description = level.description ?? [];
	const textual = description.every((part) => part.type === "text");
	if (textual) {
		return scoreLevelText(level);
	}
	return encodeParts(
		level.label === undefined
			? description
			: [{ type: "text", text: `${level.label}: ` }, ...description],
		assets,
	);
}

function questionToSystemOne(
	question: DecisionQuestion,
	assets: AssetCollector,
): Record<string, unknown> {
	const instructions =
		question.instructions.length > 0
			? { instructions: encodeParts(question.instructions, assets) }
			: {};
	switch (question.kind) {
		case "binary": {
			const { criteria } = question;
			return {
				type: "noul",
				...instructions,
				...(criteria?.true || criteria?.false
					? {
							criteria: {
								...(criteria.true
									? { true: encodeParts(criteria.true, assets) }
									: {}),
								...(criteria.false
									? { false: encodeParts(criteria.false, assets) }
									: {}),
							},
						}
					: {}),
			};
		}
		case "choice":
			return {
				type: "choice",
				...instructions,
				criteria: Object.fromEntries(
					question.options.map((option) => [
						optionKey(option.value),
						option.description ? encodeParts(option.description, assets) : null,
					]),
				),
			};
		case "score":
			return {
				type: "score",
				...instructions,
				criteria: question.levels.map((level) =>
					encodeScoreLevel(level, assets),
				),
			};
		default:
			return { type: "box", ...instructions };
	}
}

export interface SystemOneBody {
	body: Record<string, unknown>;
	/** Images or box questions, which TypeSafe only accepts behind its images header. */
	usesImages: boolean;
}

export function buildSystemOneBody(
	req: CanonicalDecisionRequest,
	upstreamModel: string,
): SystemOneBody {
	const assets = new AssetCollector();
	const keys = upstreamQuestionKeys(req.questions);
	const state = encodeParts(flattenDecisionInput(req.input), assets);
	const questions = Object.fromEntries(
		req.questions.map((question, index) => [
			keys[index],
			questionToSystemOne(question, assets),
		]),
	);
	return {
		body: {
			model: upstreamModel,
			state: state ?? "",
			questions,
			...(assets.size > 0 ? { assets: assets.assets } : {}),
		},
		usesImages:
			assets.size > 0 ||
			req.questions.some((question) => question.kind === "box"),
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

function box(value: unknown): DecisionBox | undefined {
	const raw = record(value);
	const top = number(raw?.top);
	const bottom = number(raw?.bottom);
	const left = number(raw?.left);
	const right = number(raw?.right);
	return top === undefined ||
		bottom === undefined ||
		left === undefined ||
		right === undefined
		? undefined
		: { top, bottom, left, right };
}

function answerFromSystemOne(
	question: DecisionQuestion,
	raw: unknown,
): CanonicalDecisionAnswer | undefined {
	const value = record(raw);
	const confidence = number(value?.confidence);
	const withConfidence = confidence === undefined ? {} : { confidence };
	switch (value?.type) {
		case "refusal":
			return { kind: "refusal" };
		case "noul":
			return question.kind === "binary"
				? {
						kind: "binary",
						probability: number(value.noul) ?? Number.NaN,
						...withConfidence,
					}
				: undefined;
		case "choice": {
			if (question.kind !== "choice") {
				return undefined;
			}
			const probabilities = record(value.probabilities) ?? {};
			const keys = question.options.map((option) => optionKey(option.value));
			return {
				kind: "choice",
				choice: keys.indexOf(String(value.choice)),
				probabilities: keys.map((key) => number(probabilities[key]) ?? 0),
				...withConfidence,
			};
		}
		case "score": {
			if (question.kind !== "score") {
				return undefined;
			}
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
		case "box": {
			const located = box(value.box);
			return question.kind === "box" && located
				? { kind: "box", box: located, confidence: confidence ?? null }
				: undefined;
		}
		default:
			return undefined;
	}
}

export function systemOneUsage(raw: unknown): Usage | undefined {
	const usage = record(raw);
	if (!usage) {
		return undefined;
	}
	const input = number(usage.input_tokens) ?? 0;
	const output = number(usage.output_tokens) ?? 0;
	const cached = number(record(usage.input_tokens_details)?.cached_tokens);
	// OpenRouter reports what it charged, in USD.
	const cost = number(usage.cost);
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		...(cached ? { cacheReadTokens: cached } : {}),
		...(cost === undefined ? {} : { providerCostCents: cost * 100 }),
	};
}

export function parseSystemOneResponse(
	raw: unknown,
	req: CanonicalDecisionRequest,
): CanonicalDecisionResponse {
	const value = record(raw);
	const answers = record(value?.answers) ?? {};
	const keys = upstreamQuestionKeys(req.questions);
	const usage = systemOneUsage(value?.usage);
	return {
		...(typeof value?.id === "string" ? { id: value.id } : {}),
		...(typeof value?.model === "string" ? { model: value.model } : {}),
		...(typeof value?.provider === "string"
			? { provider: value.provider }
			: {}),
		answers: req.questions.map((question, index) =>
			requireAnswer(
				answerFromSystemOne(question, answers[keys[index] ?? ""]),
				index,
			),
		),
		...(usage ? { usage } : {}),
	};
}
