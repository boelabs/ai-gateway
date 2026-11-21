import { failedResponseHandler } from "../shared/errors.ts";
import { compact, toJSONObject } from "../shared/json.ts";
import { z } from "zod/v4";

import type {
	RerankingModelV4CallOptions,
	RerankingModelV4Result,
	RerankingModelV4,
	SharedV4Warning,
} from "@ai-sdk/provider";

import {
	gatewayOptionsShape,
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
} from "../shared/gateway-options.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

import {
	createJsonResponseHandler,
	postJsonToApi,
	zodSchema,
} from "@ai-sdk/provider-utils";

export const rerankingOptionsSchema = z.object({
	...gatewayOptionsShape,
	/**
	 * OpenRouter provider routing (`only`, `order`, `allow_fallbacks`, `zdr`, …), sent unchanged.
	 * Setting it restricts the request to OpenRouter-backed deployments.
	 */
	provider: z.record(z.string(), z.unknown()).optional(),
});

export type BoelabsGatewayRerankingOptions = z.input<
	typeof rerankingOptionsSchema
>;

const responseSchema = zodSchema(
	z
		.object({
			id: z.string().nullish(),
			model: z.string().nullish(),
			provider: z.string().nullish(),
			results: z.array(
				z.object({ index: z.number(), relevance_score: z.number() }).loose(),
			),
			usage: z.record(z.string(), z.unknown()).nullish(),
		})
		.loose(),
);

/** Reranking model on the gateway's `/v1/rerank`. */
export class BoelabsGatewayRerankingModel implements RerankingModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doRerank(
		options: RerankingModelV4CallOptions,
	): Promise<RerankingModelV4Result> {
		const warnings: SharedV4Warning[] = [];
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				rerankingOptionsSchema,
			)) ?? {};
		let documents: string[];
		if (options.documents.type === "text") {
			documents = options.documents.values;
		} else {
			warnings.push({
				type: "compatibility",
				feature: "object documents",
				details: "The gateway reranks text; each object is sent as its JSON.",
			});
			documents = options.documents.values.map((document) =>
				JSON.stringify(document),
			);
		}

		const { value, rawValue, responseHeaders } = await postJsonToApi({
			url: apiUrl(this.config, "/rerank"),
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			body: compact({
				model: this.modelId,
				query: options.query,
				documents,
				top_n: options.topN,
				provider: opts.provider,
			}),
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(responseSchema),
			...transport(this.config, options.abortSignal),
		});

		return {
			ranking: value.results.map((result) => ({
				index: result.index,
				relevanceScore: result.relevance_score,
			})),
			warnings,
			providerMetadata: {
				[this.config.providerMetadataName]: toJSONObject(
					compact({
						servedBy: value.provider ?? undefined,
						usage: value.usage ?? undefined,
						...gatewayMetadata(responseHeaders),
					}),
				),
			},
			response: compact({
				id: value.id ?? undefined,
				modelId: value.model ?? undefined,
				headers: responseHeaders,
				body: rawValue,
			}),
		};
	}
}
