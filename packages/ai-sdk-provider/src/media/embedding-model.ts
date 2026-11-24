import { failedResponseHandler } from "../shared/errors.ts";
import { compact } from "../shared/json.ts";
import { z } from "zod/v4";

import {
	gatewayOptionsShape,
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
	wireModelId,
} from "../shared/gateway-options.ts";

import type {
	EmbeddingModelV4CallOptions,
	EmbeddingModelV4Result,
	EmbeddingModelV4,
} from "@ai-sdk/provider";

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

export const embeddingOptionsSchema = z.object({
	...gatewayOptionsShape,
	/** End-user identifier. */
	user: z.string().optional(),
});

export type BoelabsGatewayEmbeddingOptions = z.input<
	typeof embeddingOptionsSchema
>;

const responseSchema = zodSchema(
	z
		.object({
			model: z.string().nullish(),
			data: z.array(
				z
					.object({
						index: z.number().nullish(),
						embedding: z.array(z.number()),
					})
					.loose(),
			),
			usage: z
				.object({
					prompt_tokens: z.number().nullish(),
					total_tokens: z.number().nullish(),
				})
				.loose()
				.nullish(),
		})
		.loose(),
);

/** Embedding model on the gateway's `/v1/embeddings`. */
export class BoelabsGatewayEmbeddingModel implements EmbeddingModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;
	/** OpenAI's per-request limit; a model's profile may set a lower `max_inputs`. */
	readonly maxEmbeddingsPerCall = 2048;
	readonly supportsParallelCalls = true;

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doEmbed(
		options: EmbeddingModelV4CallOptions,
	): Promise<EmbeddingModelV4Result> {
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				embeddingOptionsSchema,
			)) ?? {};
		const { value, rawValue, responseHeaders } = await postJsonToApi({
			url: apiUrl(this.config, "/embeddings"),
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			body: compact({
				model: wireModelId(this.modelId, opts.serviceMode),
				input: options.values,
				encoding_format: "float",
				dimensions: options.dimensions,
				user: opts.user,
				extra_body: opts.extraBody,
			}),
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(responseSchema),
			...transport(this.config, options.abortSignal),
		});
		const ordered = [...value.data].sort(
			(a, b) => (a.index ?? 0) - (b.index ?? 0),
		);
		const tokens = value.usage?.prompt_tokens ?? value.usage?.total_tokens;
		return {
			embeddings: ordered.map((item) => item.embedding),
			...(tokens == null ? {} : { usage: { tokens } }),
			providerMetadata: {
				[this.config.providerMetadataName]: gatewayMetadata(responseHeaders),
			},
			response: compact({ headers: responseHeaders, body: rawValue }),
			warnings: [],
		};
	}
}
