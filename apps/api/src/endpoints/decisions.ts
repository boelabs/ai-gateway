import { assertDecisionRequestSupported } from "#gateway/decisionValidation.ts";
import { assertDecisionResponseValid } from "#gateway/decisionValidation.ts";
import { estimateTokenReservation } from "#router/tokenReservation.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import type { DecisionsExecResult } from "#gateway/executor.ts";
import { route, type RouteResult } from "#router/index.ts";
import { executeDecisions } from "#gateway/executor.ts";
import type { CostBreakdown } from "#logging/cost.ts";
import { readBodyBytes } from "#http/body.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import type { Context } from "hono";

import {
	applyCanonicalResponseExtensions,
	applyCanonicalRequestExtensions,
	PUBLIC_JSON_BODY_MAX_BYTES,
	assertFinalModelAllowed,
	notifyExtensionError,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	openAIDecisionRequestToCanonical,
	openAIDecisionRequestSchema,
	toOpenAIDecisionResponse,
} from "#contracts/openai/decisions.ts";

import {
	geminiDecisionRequestToCanonical,
	geminiDecisionRequestSchema,
	toGeminiDecisionResponse,
} from "#contracts/google/decisions.ts";

import {
	systemOneRequestToCanonical,
	systemOneRequestSchema,
	toSystemOneResponse,
	parseSystemOneBody,
	isMultipart,
} from "#contracts/typesafe/systemone.ts";

import {
	decisionResponseSummary,
	decisionRequestSummary,
} from "#decisions/logging.ts";

import type {
	CanonicalDecisionResponse,
	CanonicalDecisionRequest,
} from "#core/decisions.ts";

/** TypeSafe's own request limit; JSON and multipart alike. */
export const MAX_SYSTEMONE_BODY_BYTES = 32 * 1024 * 1024;

interface DecisionContract {
	/** The public endpoint, recorded on the operation log. */
	endpoint: string;
	read: (c: Context<AppEnv>) => Promise<CanonicalDecisionRequest>;
	render: (
		request: CanonicalDecisionRequest,
		response: CanonicalDecisionResponse,
		cost: CostBreakdown | null,
	) => Record<string, unknown>;
}

/**
 * The bytes a reservation should count: the canonical request with inline media replaced by its
 * token bound, which `estimateTokenReservation` recognizes in the `{ data, mime_type }` shape.
 */
function reservationPayload(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(reservationPayload);
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const record = value as Record<string, unknown>;
	if (record.kind === "data" && typeof record.data === "string") {
		return { data: record.data, mime_type: record.mimeType };
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, item]) => [
			key,
			reservationPayload(item),
		]),
	);
}

function makeDecisionsHandler(contract: DecisionContract) {
	return async function decisionsHandler(
		c: Context<AppEnv>,
	): Promise<Response> {
		const log = new OperationLogDraft(c, "decisions");
		let routing: RouteResult<DecisionsExecResult> | null = null;
		let fallbackUsage: Usage | null = null;
		let finished = false;

		const finish = async (
			usage: Usage | null,
			error?: ReturnType<typeof toGatewayError> | null,
		): Promise<Usage | null> => {
			if (!routing || finished) {
				return null;
			}
			finished = true;
			return routing.finish(usage ?? fallbackUsage, undefined, error);
		};

		try {
			let canonical = await contract.read(c);
			log.publicModel = canonical.model;
			await preflight(c, canonical.model);
			canonical = await applyCanonicalRequestExtensions(
				c,
				"decisions",
				canonical,
			);
			log.requestBody = decisionRequestSummary(canonical);
			log.publicModel = canonical.model;
			assertFinalModelAllowed(c, canonical.model);
			const reservation = estimateTokenReservation(
				reservationPayload(canonical),
			);

			routing = await route(
				canonical.model,
				"decisions",
				{
					clientSignal: log.clientSignal,
					requestId: log.requestId,
					operationId: log.operationId,
					candidateEligibility: (candidate) =>
						assertDecisionRequestSupported(canonical, candidate),
					tokenReservation: () => reservation,
					usageQuota: usageQuotaForRequest(c),
				},
				(candidate, ctx) => executeDecisions(candidate.adapter, canonical, ctx),
			);
			log.applyRouting(routing);
			fallbackUsage = routing.value.response.usage ?? null;
			log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;

			const response = await applyCanonicalResponseExtensions(
				c,
				"decisions",
				canonical.model,
				routing.value.response,
			);
			assertDecisionResponseValid(canonical, response);
			const usage = response.usage ?? null;
			const settledUsage = (await finish(usage)) ?? usage;
			const cost = computeUsageCost(routing.candidate.meta, settledUsage);
			const rendered = contract.render(canonical, response, cost);
			log.write({
				status: "success",
				httpStatus: 200,
				usage: settledUsage,
				cost,
				firstOutputMs: null,
				responseBody: decisionResponseSummary(response, cost),
				metadata: {
					...candidateMetadata(routing.candidate),
					terminal: routing.value.terminal,
					endpoint: contract.endpoint,
				},
				error: null,
			});
			return c.json(rendered);
		} catch (error) {
			const ge = toGatewayError(error);
			log.applyFailedAttempts(ge.attempts);
			await finish(null, ge);
			await notifyExtensionError(c, "decisions", log.publicModel, ge);
			log.writeError(ge);
			throw ge;
		}
	};
}

/** POST /v1/decisions — OpenAI's Decisions API. */
export const openAIDecisionsHandler = makeDecisionsHandler({
	endpoint: "/v1/decisions",
	async read(c) {
		const json = await readJsonBody(c, PUBLIC_JSON_BODY_MAX_BYTES);
		return openAIDecisionRequestToCanonical(
			parseBody(openAIDecisionRequestSchema, json),
		);
	},
	render: (request, response) => toOpenAIDecisionResponse(request, response),
});

/** POST /v1beta/decisions — Google's Gemini Decisions API. */
export const geminiDecisionsHandler = makeDecisionsHandler({
	endpoint: "/v1beta/decisions",
	async read(c) {
		const json = await readJsonBody(c, PUBLIC_JSON_BODY_MAX_BYTES);
		return geminiDecisionRequestToCanonical(
			parseBody(geminiDecisionRequestSchema, json),
		);
	},
	render: (request, response) => toGeminiDecisionResponse(request, response),
});

/** POST /v1/systemone — TypeSafe's Jev API, JSON or multipart. */
export const systemOneDecisionsHandler = makeDecisionsHandler({
	endpoint: "/v1/systemone",
	async read(c) {
		const contentType = c.req.header("content-type") ?? "";
		const json = isMultipart(contentType)
			? await parseSystemOneBody(
					contentType,
					await readBodyBytes(c, MAX_SYSTEMONE_BODY_BYTES),
				)
			: await readJsonBody(c, MAX_SYSTEMONE_BODY_BYTES);
		return systemOneRequestToCanonical(parseBody(systemOneRequestSchema, json));
	},
	render: (request, response) => toSystemOneResponse(request, response),
});
