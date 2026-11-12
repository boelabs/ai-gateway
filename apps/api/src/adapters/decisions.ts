import type { AdapterContext, DecisionsHandler } from "#adapters/types.ts";
import { type BaseCreds, requireApiKeyCreds } from "#adapters/creds.ts";
import { adapterContextDiagnostics } from "#adapters/diagnostics.ts";
import type { CanonicalDecisionResponse } from "#core/decisions.ts";
import { mapUpstreamHttpError } from "#adapters/upstreamError.ts";

import {
	parseOpenAIDecisionResponse,
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

/** OpenAI `POST /decisions`. */
export function makeOpenAIDecisionsHandler(
	defaultBaseUrl = "https://api.openai.com/v1",
	label = "OpenAI",
): DecisionsHandler {
	return {
		buildRequest(req, ctx) {
			const creds = credentials(ctx, label, defaultBaseUrl);
			return {
				method: "POST",
				url: `${creds.base}/decisions`,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${creds.apiKey}`,
					...(creds.organization
						? { "openai-organization": creds.organization }
						: {}),
					...(creds.headers ?? {}),
				},
				body: JSON.stringify(buildOpenAIDecisionBody(req, ctx.upstreamModel)),
			};
		},
		parseResponse(raw, ctx, req) {
			return withProviderRequestId(parseOpenAIDecisionResponse(raw, req), ctx);
		},
		mapError(err, ctx) {
			return mapUpstreamHttpError(err, { label }, ctx);
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
