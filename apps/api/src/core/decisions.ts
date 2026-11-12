import { GatewayError } from "./errors.ts";
import type { Usage } from "./usage.ts";

/**
 * Canonical decisions: one shared input scored against a set of closed-set questions, answered with
 * probabilities instead of generated text. OpenAI `/v1/decisions`, Gemini `/v1beta/decisions` and
 * TypeSafe `/v1/systemone` all render from and parse into this shape.
 */

/** Where a media part's bytes live. `data` is plain base64, never a data URL. */
export type DecisionMediaSource =
	| { kind: "url"; url: string; mimeType?: string }
	| { kind: "data"; data: string; mimeType: string };

export type DecisionImageDetail =
	| "low"
	| "medium"
	| "high"
	| "ultra_high"
	| "auto"
	| "original";

export type DecisionContentPart =
	| { type: "text"; text: string; cacheBreakpoint?: true }
	/** A structured value the model reads as JSON. */
	| { type: "json"; data: unknown }
	| {
			type: "image";
			source: DecisionMediaSource;
			detail?: DecisionImageDetail;
			cacheBreakpoint?: true;
	  }
	| { type: "audio"; source: DecisionMediaSource }
	| { type: "video"; source: DecisionMediaSource }
	| { type: "document"; source: DecisionMediaSource };

export type DecisionMessageRole = "user" | "system" | "developer" | "assistant";

export type DecisionInputItem =
	| {
			type: "message";
			role: DecisionMessageRole;
			content: DecisionContentPart[];
	  }
	| {
			type: "tool_call";
			tool: "function" | "custom";
			callId: string;
			name: string;
			/** Function arguments (JSON text) or a custom tool's raw input. */
			input: string;
	  }
	| {
			type: "tool_result";
			tool: "function" | "custom";
			callId: string;
			output: DecisionContentPart[];
	  };

interface DecisionQuestionBase {
	/** The name the client gave the question; `null` when it sent none (OpenAI allows that). */
	key: string | null;
	instructions: DecisionContentPart[];
}

export interface BinaryDecisionQuestion extends DecisionQuestionBase {
	kind: "binary";
	/** What counts as yes and as no (TypeSafe/Gemini `noul` criteria). */
	criteria?: { true?: DecisionContentPart[]; false?: DecisionContentPart[] };
}

export interface ChoiceDecisionOption {
	/** OpenAI choices are typed: the string "true" and the boolean `true` are distinct options. */
	value: string | boolean;
	description?: DecisionContentPart[];
}

export interface ChoiceDecisionQuestion extends DecisionQuestionBase {
	kind: "choice";
	options: ChoiceDecisionOption[];
}

export interface ScoreDecisionLevel {
	/** A short name for the level (OpenAI `label`); absent when the level is only described. */
	label?: string;
	description?: DecisionContentPart[];
}

export interface ScoreDecisionQuestion extends DecisionQuestionBase {
	kind: "score";
	/** Ordered from lowest to highest; a level's index is its score. */
	levels: ScoreDecisionLevel[];
}

/** Locate a target in an image (TypeSafe Jev 1.14 only). */
export interface BoxDecisionQuestion extends DecisionQuestionBase {
	kind: "box";
}

export type DecisionQuestion =
	| BinaryDecisionQuestion
	| ChoiceDecisionQuestion
	| ScoreDecisionQuestion
	| BoxDecisionQuestion;

export type DecisionQuestionKind = DecisionQuestion["kind"];

export interface DecisionPromptCache {
	key?: string;
	mode?: "implicit" | "explicit";
	ttl?: string;
}

export interface CanonicalDecisionRequest {
	model: string;
	input: DecisionInputItem[];
	questions: DecisionQuestion[];
	promptCache?: DecisionPromptCache;
	/** Opaque end-user identifier for upstream abuse monitoring. */
	user?: string;
}

export interface DecisionBox {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/** One answer, aligned by index with `CanonicalDecisionRequest.questions`. */
export type CanonicalDecisionAnswer =
	| { kind: "binary"; probability: number; confidence?: number }
	| {
			kind: "choice";
			/** Index into the question's `options`. */
			choice: number;
			/** One probability per option, in option order. */
			probabilities: number[];
			confidence?: number;
	  }
	| {
			kind: "score";
			/** Probability-weighted mean level index; can fall between levels. */
			score: number;
			/** One probability per level, in level order. */
			probabilities: number[];
			confidence?: number;
	  }
	| { kind: "box"; box: DecisionBox; confidence: number | null }
	| { kind: "refusal" };

export interface DecisionBlock {
	reason: string;
	message?: string;
}

export interface CanonicalDecisionResponse {
	id?: string;
	/** The versioned model that answered, when the upstream reports it. */
	model?: string;
	provider?: string;
	answers: CanonicalDecisionAnswer[];
	/** Set when the upstream refused the whole input; `answers` is then all refusals. */
	blocked?: DecisionBlock;
	usage?: Usage;
}

/** What one deployment's decision model accepts. Every limit is inclusive and optional. */
export interface DecisionProfile {
	questionKinds: DecisionQuestionKind[];
	inputModalities: Array<"text" | "image" | "audio" | "video" | "document">;
	/** Content allowed inside instructions and criteria. Text is always allowed. */
	instructionModalities?: Array<"image" | "json">;
	maxQuestions?: number;
	minChoices?: number;
	maxChoices?: number;
	minScoreLevels?: number;
	maxScoreLevels?: number;
	/** Documented upstream context window; the gateway does not tokenize locally. */
	contextWindow?: number;
}

export function binaryConfidence(probability: number): number {
	return Math.max(probability, 1 - probability);
}

export function maxProbability(probabilities: readonly number[]): number {
	return probabilities.reduce((max, value) => Math.max(max, value), 0);
}

/** Index of the most probable entry; ties go to the first. */
export function argmax(probabilities: readonly number[]): number {
	let best = 0;
	for (let index = 1; index < probabilities.length; index++) {
		if ((probabilities[index] ?? 0) > (probabilities[best] ?? 0)) {
			best = index;
		}
	}
	return best;
}

export function expectedLevel(probabilities: readonly number[]): number {
	return probabilities.reduce(
		(sum, probability, index) => sum + probability * index,
		0,
	);
}

/** The option key an upstream that names options by string sees. */
export function optionKey(value: string | boolean): string {
	return typeof value === "string" ? value : String(value);
}

const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * Keys for upstreams that address questions by name (Gemini, TypeSafe, OpenRouter): the client's own
 * key when it is valid and unique, otherwise `q<index>`, made unique.
 */
export function upstreamQuestionKeys(
	questions: readonly DecisionQuestion[],
): string[] {
	const used = new Set<string>();
	const keys: string[] = [];
	for (const [index, question] of questions.entries()) {
		let key =
			question.key !== null &&
			QUESTION_KEY.test(question.key) &&
			!used.has(question.key)
				? question.key
				: `q${index}`;
		let suffix = 1;
		while (used.has(key)) {
			key = `q${index}_${suffix++}`;
		}
		used.add(key);
		keys.push(key);
	}
	return keys;
}

/** Plain text of parts, for upstreams that only take text in a given position. */
export function partsAsText(parts: readonly DecisionContentPart[]): string {
	return parts
		.map((part) => {
			if (part.type === "text") {
				return part.text;
			}
			if (part.type === "json") {
				return JSON.stringify(part.data);
			}
			throw new TypeError(`A ${part.type} part has no text form`);
		})
		.join("");
}

export function partsAreTextual(
	parts: readonly DecisionContentPart[],
): boolean {
	return parts.every((part) => part.type === "text" || part.type === "json");
}

export function textParts(text: string): DecisionContentPart[] {
	return [{ type: "text", text }];
}

/** Every media part in the request, wherever it sits. */
export function decisionMediaParts(
	request: CanonicalDecisionRequest,
): Array<{ part: DecisionContentPart; where: "input" | "question" }> {
	const found: Array<{
		part: DecisionContentPart;
		where: "input" | "question";
	}> = [];
	const collect = (
		parts: readonly DecisionContentPart[],
		where: "input" | "question",
	) => {
		for (const part of parts) {
			if (part.type !== "text" && part.type !== "json") {
				found.push({ part, where });
			}
		}
	};
	for (const item of request.input) {
		collect(inputItemParts(item), "input");
	}
	for (const question of request.questions) {
		collect(question.instructions, "question");
		for (const parts of questionCriteriaParts(question)) {
			collect(parts, "question");
		}
	}
	return found;
}

/** The content an input item carries; a tool call carries none. */
export function inputItemParts(item: DecisionInputItem): DecisionContentPart[] {
	if (item.type === "message") {
		return item.content;
	}
	return item.type === "tool_result" ? item.output : [];
}

export function questionCriteriaParts(
	question: DecisionQuestion,
): DecisionContentPart[][] {
	switch (question.kind) {
		case "binary":
			return [question.criteria?.true, question.criteria?.false].filter(
				(parts): parts is DecisionContentPart[] => parts !== undefined,
			);
		case "choice":
			return question.options.flatMap((option) =>
				option.description ? [option.description] : [],
			);
		case "score":
			return question.levels.flatMap((level) =>
				level.description ? [level.description] : [],
			);
		default:
			return [];
	}
}

export function parseDataUrl(
	url: string,
): { mimeType: string; data: string } | null {
	const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/su.exec(url);
	return match?.[1] !== undefined && match[2] !== undefined
		? { mimeType: match[1], data: match[2] }
		: null;
}

export function sourceAsUrl(source: DecisionMediaSource): string {
	return source.kind === "url"
		? source.url
		: `data:${source.mimeType};base64,${source.data}`;
}

const ROLE_LABEL: Record<DecisionMessageRole, string> = {
	user: "User",
	system: "System",
	developer: "Developer",
	assistant: "Assistant",
};

/**
 * The input as one ordered list of parts, for upstreams that take a single input and no conversation
 * (Gemini, TypeSafe). A lone user message passes through untouched; anything richer is labeled by
 * role so the model still sees who said what.
 */
export function flattenDecisionInput(
	input: readonly DecisionInputItem[],
): DecisionContentPart[] {
	const [only] = input;
	if (input.length === 1 && only?.type === "message" && only.role === "user") {
		return only.content;
	}
	const parts: DecisionContentPart[] = [];
	for (const [index, item] of input.entries()) {
		const separator = index === 0 ? "" : "\n\n";
		switch (item.type) {
			case "message":
				parts.push(
					{ type: "text", text: `${separator}${ROLE_LABEL[item.role]}:\n` },
					...item.content,
				);
				break;
			case "tool_call":
				parts.push({
					type: "text",
					text: `${separator}Tool call ${item.name} (${item.callId}):\n${item.input}`,
				});
				break;
			default:
				parts.push(
					{ type: "text", text: `${separator}Tool result (${item.callId}):\n` },
					...item.output,
				);
				break;
		}
	}
	return parts;
}

/** Joins adjacent text parts, so text-only upstreams receive one string where possible. */
export function mergeTextParts(
	parts: readonly DecisionContentPart[],
): DecisionContentPart[] {
	const out: DecisionContentPart[] = [];
	for (const part of parts) {
		const last = out.at(-1);
		if (part.type === "text" && last?.type === "text") {
			out[out.length - 1] = { type: "text", text: last.text + part.text };
		} else {
			out.push(part.type === "text" ? { type: "text", text: part.text } : part);
		}
	}
	return out;
}

/** The text an upstream that names score levels by one string shows for a level. */
export function scoreLevelText(level: ScoreDecisionLevel): string {
	const description =
		level.description && partsAreTextual(level.description)
			? partsAsText(level.description)
			: undefined;
	if (level.label !== undefined && description) {
		return `${level.label}: ${description}`;
	}
	return level.label ?? description ?? "";
}

const IMAGE_FORMATS: Record<string, "png" | "jpg"> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
};

/** TypeSafe asset format for a MIME type, or `undefined` when TypeSafe cannot take it. */
export function typeSafeImageFormat(
	mimeType: string,
): "png" | "jpg" | undefined {
	return IMAGE_FORMATS[mimeType.toLowerCase()];
}

/** The upstream answered in a shape that does not fit the questions it was asked. */
export function decisionProtocolError(message: string): GatewayError {
	return new GatewayError({
		class: "server",
		code: "upstream_protocol_error",
		message,
		failureKind: "transient",
		deploymentHealth: "penalize",
	});
}

/** An answer that must exist: a missing or mistyped one is the upstream's protocol error. */
export function requireAnswer(
	answer: CanonicalDecisionAnswer | undefined,
	index: number,
): CanonicalDecisionAnswer {
	if (answer === undefined) {
		throw decisionProtocolError(
			`Upstream decision response has no valid answer for question ${index}`,
		);
	}
	return answer;
}
