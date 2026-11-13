import type { AdapterContext, DecisionsHandler } from "#adapters/types.ts";
import { type BaseCreds, requireApiKeyCreds } from "#adapters/creds.ts";
import { adapterContextDiagnostics } from "#adapters/diagnostics.ts";
import type { CanonicalDecisionResponse } from "#core/decisions.ts";
import { mapUpstreamHttpError } from "#adapters/upstreamError.ts";
import { GatewayError, type ErrorClass } from "#core/errors.ts";

import {
	parseOpenAIDecisionResponse,
	type OpenAIDecisionDialect,
	buildOpenAIDecisionBody,
} from "#contracts/openai/decisionsTransport.ts";

import {
	parseGeminiDecisionResponse,
	buildGeminiDecisionBody,
} from "#contracts/google/decisions.ts";

import {
	parseSystemOneResponse,
	buildSystemOneBody,
} from "#contracts/typesafe/systemone.ts";

/**
 * Decisions handlers, one per upstream protocol. The wire codecs live with the contracts of the same
 * shape, because the gateway both serves and calls each of them.
 */

const TRAILING_SLASHES = /\/+$/u;

interface Creds extends BaseCreds {
	organization?: string;
}

function credentials(
	ctx: AdapterContext,
	label: string,
	defaultBaseUrl: string,
) {
	const creds = requireApiKeyCreds<Creds>(ctx.credentials, label);
	return {
		...creds,
		base: (creds.baseUrl ?? defaultBaseUrl).replace(/\/+$/u, ""),
	};
}

function withProviderRequestId(
	response: CanonicalDecisionResponse,
	ctx: AdapterContext,
): CanonicalDecisionResponse {
	if (response.id !== undefined) {
		adapterContextDiagnostics(ctx).providerRequestId = response.id;
	}
	if (response.model !== undefined) {
		adapterContextDiagnostics(ctx).modelVersion = response.model;
	}
	return response;
}

export interface OpenAIDecisionsConfig {
	label: string;
	/** Absent when the deployment must name its own base URL (Azure resources). */
	defaultBaseUrl?: string;
	/** Azure's v1 surface takes the key in `api-key`; OpenAI takes a Bearer token. */
	authScheme?: "bearer" | "api-key";
	normalizeBaseUrl?: (baseUrl: string) => string;
	dialect?: OpenAIDecisionDialect;
	refineBadRequest?: (message: string, body: unknown) => ErrorClass | null;
}

function openAIStyleBase(creds: Creds, config: OpenAIDecisionsConfig): string {
	const base = creds.baseUrl ?? config.defaultBaseUrl;
	if (base === undefined) {
		throw new GatewayError({
			class: "server",
			failureKind: "configuration",
			message: `${config.label}: missing 'baseUrl' in credentials`,
		});
	}
	return config.normalizeBaseUrl
		? config.normalizeBaseUrl(base)
		: base.replace(TRAILING_SLASHES, "");
}

/** OpenAI `POST /decisions`, and Azure OpenAI's `POST /openai/v1/decisions`. */
export function makeOpenAIDecisionsHandler(
	config: OpenAIDecisionsConfig = {
		label: "OpenAI",
		defaultBaseUrl: "https://api.openai.com/v1",
	},
): DecisionsHandler {
	const { label } = config;
	const apiKeyHeader = config.authScheme === "api-key";
	return {
		buildRequest(req, ctx) {
			const creds = requireApiKeyCreds<Creds>(ctx.credentials, label);
			return {
				method: "POST",
				url: `${openAIStyleBase(creds, config)}/decisions`,
				headers: {
					"content-type": "application/json",
					...(apiKeyHeader
						? { "api-key": creds.apiKey }
						: { authorization: `Bearer ${creds.apiKey}` }),
					...(creds.organization && !apiKeyHeader
						? { "openai-organization": creds.organization }
						: {}),
					...(creds.headers ?? {}),
				},
				body: JSON.stringify(
					buildOpenAIDecisionBody(req, ctx.upstreamModel, config.dialect),
				),
			};
		},
		parseResponse(raw, ctx, req) {
			return withProviderRequestId(parseOpenAIDecisionResponse(raw, req), ctx);
		},
		mapError(err, ctx) {
			return mapUpstreamHttpError(
				err,
				{
					label,
					...(config.refineBadRequest
						? { refineBadRequest: config.refineBadRequest }
						: {}),
				},
				ctx,
			);
		},
	};
}

/** Google Gemini `POST /v1beta/decisions`. */
export function makeGeminiDecisionsHandler(
	defaultBaseUrl = "https://generativelanguage.googleapis.com/v1beta",
	label = "Google AI Studio",
	mapError?: DecisionsHandler["mapError"],
): DecisionsHandler {
	return {
		buildRequest(req, ctx) {
			const creds = credentials(ctx, label, defaultBaseUrl);
			return {
				method: "POST",
				url: `${creds.base}/decisions`,
				headers: {
					"content-type": "application/json",
					"x-goog-api-key": creds.apiKey,
					...(creds.headers ?? {}),
				},
				body: JSON.stringify(buildGeminiDecisionBody(req, ctx.upstreamModel)),
			};
		},
		parseResponse(raw, ctx, req) {
			return withProviderRequestId(parseGeminiDecisionResponse(raw, req), ctx);
		},
		mapError(err, ctx) {
			return mapError
				? mapError(err, ctx)
				: mapUpstreamHttpError(err, { label }, ctx);
		},
	};
}

/** TypeSafe `POST /v1/systemone`. Requests with images or box questions need its images header. */
export function makeSystemOneDecisionsHandler(
	defaultBaseUrl = "https://api.typesafe.ai",
	label = "TypeSafe",
): DecisionsHandler {
	return {
		buildRequest(req, ctx) {
			const creds = credentials(ctx, label, defaultBaseUrl);
			const { body, usesImages } = buildSystemOneBody(req, ctx.upstreamModel);
			return {
				method: "POST",
				url: `${creds.base}/v1/systemone`,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${creds.apiKey}`,
					...(usesImages ? { "typesafe-danger-zone-images": "true" } : {}),
					...(creds.headers ?? {}),
				},
				body: JSON.stringify(body),
			};
		},
		parseResponse(raw, ctx, req) {
			return withProviderRequestId(parseSystemOneResponse(raw, req), ctx);
		},
		mapError(err, ctx) {
			return mapUpstreamHttpError(err, { label }, ctx);
		},
	};
}

/**
 * OpenRouter `POST /api/alpha/decisions`: TypeSafe's body, routed to any decision model OpenRouter
 * serves. The alpha path sits beside `/api/v1`, so it is derived from the configured base URL.
 */
export function makeOpenRouterDecisionsHandler(
	defaultBaseUrl = "https://openrouter.ai/api/v1",
	label = "OpenRouter",
): DecisionsHandler {
	return {
		buildRequest(req, ctx) {
			const creds = credentials(ctx, label, defaultBaseUrl);
			const { body } = buildSystemOneBody(req, ctx.upstreamModel);
			const base = creds.base.replace(/\/v1$/u, "");
			return {
				method: "POST",
				url: `${base}/alpha/decisions`,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${creds.apiKey}`,
					...(creds.headers ?? {}),
				},
				body: JSON.stringify({
					...body,
					...(req.user ? { user: req.user } : {}),
				}),
			};
		},
		parseResponse(raw, ctx, req) {
			return withProviderRequestId(parseSystemOneResponse(raw, req), ctx);
		},
		mapError(err, ctx) {
			return mapUpstreamHttpError(err, { label }, ctx);
		},
	};
}
