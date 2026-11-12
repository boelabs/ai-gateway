import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { ContentPartInputSupport } from "#adapters/types.ts";
import { resolveTransport } from "#router/transport.ts";
import { decisionProfileFor } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

import {
	type CanonicalDecisionResponse,
	type CanonicalDecisionRequest,
	type CanonicalDecisionAnswer,
	type DecisionContentPart,
	type DecisionQuestion,
	questionCriteriaParts,
	inputItemParts,
	decisionProtocolError,
	optionKey,
} from "#core/decisions.ts";

function unsupported(param: string, message: string): never {
	throw new GatewayError({
		class: "bad_request",
		code: "unsupported_parameter",
		message,
		publicMessage: message,
		param,
	});
}

type MediaPart = Exclude<
	DecisionContentPart,
	{ type: "text" } | { type: "json" }
>;

/** Transports that address options by their string form, where `"true"` and `true` collide. */
const STRING_KEYED_TRANSPORTS = new Set([
	"gemini_decisions",
	"systemone",
	"openrouter_decisions",
]);

function inputSupportFor(
	part: MediaPart,
	support:
		| Partial<
				Record<"image" | "audio" | "video" | "file", ContentPartInputSupport>
		  >
		| undefined,
): ContentPartInputSupport | undefined {
	return support?.[part.type === "document" ? "file" : part.type];
}

function mimeAllowed(
	mimeType: string | undefined,
	allowed: readonly string[] | undefined,
): boolean {
	if (allowed === undefined || mimeType === undefined) {
		return true;
	}
	const lower = mimeType.toLowerCase();
	return allowed.some((entry) =>
		entry.endsWith("/*")
			? lower.startsWith(entry.slice(0, -1))
			: lower === entry,
	);
}

function assertMediaPart(
	part: MediaPart,
	param: string,
	support: ContentPartInputSupport | undefined,
): void {
	const label = part.type === "document" ? "document" : part.type;
	if (!support) {
		unsupported(
			param,
			`The selected model does not accept ${label} input here.`,
		);
	}
	const { source } = part;
	if (!support.sources.includes(source.kind === "url" ? "url" : "data_url")) {
		unsupported(
			param,
			source.kind === "url"
				? `The selected model takes ${label} input as inline data, not a URL.`
				: `The selected model takes ${label} input as a URL, not inline data.`,
		);
	}
	if (!mimeAllowed(source.mimeType, support.mimeTypes)) {
		unsupported(
			param,
			`The selected model does not accept ${source.mimeType} ${label} input.`,
		);
	}
	if (
		source.kind === "data" &&
		support.maxBytes !== undefined &&
		Math.floor((source.data.length * 3) / 4) > support.maxBytes
	) {
		unsupported(
			param,
			`The ${label} exceeds the selected model's ${support.maxBytes} byte limit.`,
		);
	}
}

function assertQuestionShape(
	question: DecisionQuestion,
	index: number,
	limits: ReturnType<typeof decisionProfileFor> & object,
	stringKeyed: boolean,
): void {
	const param = `questions.${index}`;
	if (!limits.questionKinds.includes(question.kind)) {
		unsupported(
			param,
			`The selected model does not answer ${question.kind} questions.`,
		);
	}
	if (question.kind === "choice") {
		const count = question.options.length;
		if (
			(limits.minChoices !== undefined && count < limits.minChoices) ||
			(limits.maxChoices !== undefined && count > limits.maxChoices)
		) {
			unsupported(
				param,
				`The selected model takes ${limits.minChoices ?? 1} to ${limits.maxChoices ?? "any number of"} choices.`,
			);
		}
		if (stringKeyed) {
			const keys = new Set(
				question.options.map((option) => optionKey(option.value)),
			);
			if (keys.size !== count) {
				unsupported(
					param,
					"The selected model names choices by text, so a boolean and a string with the same text cannot both be choices.",
				);
			}
		}
	}
	if (question.kind === "score") {
		const count = question.levels.length;
		if (
			(limits.minScoreLevels !== undefined && count < limits.minScoreLevels) ||
			(limits.maxScoreLevels !== undefined && count > limits.maxScoreLevels)
		) {
			unsupported(
				param,
				`The selected model takes ${limits.minScoreLevels ?? 1} to ${limits.maxScoreLevels ?? "any number of"} score levels.`,
			);
		}
	}
}

/**
 * Whether one deployment can answer this request as asked: question kinds and counts from its
 * catalog profile, media from its transport's declared content inputs. A failure makes the
 * candidate ineligible rather than failing the request, so the router tries the rest of the pool.
 */
export function assertDecisionRequestSupported(
	request: CanonicalDecisionRequest,
	candidate: DeploymentCandidate,
): void {
	const profile = decisionProfileFor(candidate.meta);
	if (!profile) {
		unsupported("model", "The selected model has no decisions profile.");
	}
	const transport = resolveTransport(candidate, "decisions");
	const support = candidate.adapter.contentInputs?.[transport];
	if (
		profile.maxQuestions !== undefined &&
		request.questions.length > profile.maxQuestions
	) {
		unsupported(
			"questions",
			`The selected model takes at most ${profile.maxQuestions} questions.`,
		);
	}
	const stringKeyed = STRING_KEYED_TRANSPORTS.has(transport);
	const inputModalities = new Set<string>(profile.inputModalities);
	const instructionModalities = new Set<string>(
		profile.instructionModalities ?? [],
	);

	for (const [index, item] of request.input.entries()) {
		for (const part of inputItemParts(item)) {
			if (part.type === "text" || part.type === "json") {
				continue;
			}
			if (!inputModalities.has(part.type)) {
				unsupported(
					`input.${index}`,
					`The selected model does not accept ${part.type} input.`,
				);
			}
			assertMediaPart(part, `input.${index}`, inputSupportFor(part, support));
		}
	}
	for (const [index, question] of request.questions.entries()) {
		assertQuestionShape(question, index, profile, stringKeyed);
		for (const parts of [
			question.instructions,
			...questionCriteriaParts(question),
		]) {
			for (const part of parts) {
				if (part.type === "text" || part.type === "json") {
					continue;
				}
				if (part.type !== "image" || !instructionModalities.has("image")) {
					unsupported(
						`questions.${index}`,
						`The selected model takes only text in questions, not ${part.type}.`,
					);
				}
				assertMediaPart(
					part,
					`questions.${index}`,
					inputSupportFor(part, support),
				);
			}
		}
	}
}

const PROBABILITY_TOLERANCE = 1e-6;

function answerProbabilities(answer: CanonicalDecisionAnswer): number[] {
	switch (answer.kind) {
		case "binary":
			return [answer.probability];
		case "choice":
		case "score":
			return answer.probabilities;
		default:
			return [];
	}
}

function isProbability(value: number): boolean {
	return (
		Number.isFinite(value) &&
		value >= -PROBABILITY_TOLERANCE &&
		value <= 1 + PROBABILITY_TOLERANCE
	);
}

/** The upstream answered every question, each in the kind it was asked, with real probabilities. */
export function assertDecisionResponseValid(
	request: CanonicalDecisionRequest,
	response: CanonicalDecisionResponse,
): void {
	if (response.answers.length !== request.questions.length) {
		throw decisionProtocolError(
			`Upstream returned ${response.answers.length} answers for ${request.questions.length} questions`,
		);
	}
	for (const [index, answer] of response.answers.entries()) {
		const question = request.questions[index];
		if (!question || answer.kind === "refusal") {
			continue;
		}
		if (answer.kind !== question.kind) {
			throw decisionProtocolError(
				`Upstream answered question ${index} as ${answer.kind}, but it is a ${question.kind} question`,
			);
		}
		const probabilities = answerProbabilities(answer);
		if (!probabilities.every(isProbability)) {
			throw decisionProtocolError(
				`Upstream returned an invalid probability for question ${index}`,
			);
		}
		if (
			answer.kind === "choice" &&
			question.kind === "choice" &&
			(answer.choice < 0 || answer.choice >= question.options.length)
		) {
			throw decisionProtocolError(
				`Upstream chose an unknown option for question ${index}`,
			);
		}
		if (answer.kind === "score" && !Number.isFinite(answer.score)) {
			throw decisionProtocolError(
				`Upstream returned an invalid score for question ${index}`,
			);
		}
	}
}
