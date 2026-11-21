import { failedResponseHandler } from "./shared/errors.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "./shared/config.ts";

import {
	createJsonResponseHandler,
	getFromApi,
	jsonSchema,
} from "@ai-sdk/provider-utils";

/** Operations a public model can serve, and the endpoints they answer on. */
export type BoelabsGatewayOperationId =
	| "text.generate"
	| "image.generate"
	| "image.edit"
	| "video.generate"
	| "audio.transcribe"
	| "audio.speech"
	| "audio.transcribe.realtime"
	| "audio.converse.realtime"
	| "audio.translate.realtime"
	| "audio.live"
	| "embedding.create"
	| "rerank"
	| "decision.create"
	| (string & {});

export interface BoelabsGatewayParameterConstraint {
	min?: number;
	max?: number;
	values?: Array<string | number | boolean>;
}

export interface BoelabsGatewayImageOperationCapabilities {
	sizes: string[];
	arbitrary_sizes: boolean;
	qualities: string[];
	output_formats: string[];
	transparent_background: boolean;
	style: boolean;
	mask: boolean;
	max_n?: number;
	max_input_images?: number;
}

/**
 * A public model as `GET /v1/models` describes it: one entry per public name, aggregated across
 * every deployment behind it. Capability blocks are what every deployment of the pool accepts.
 */
export interface BoelabsGatewayModel {
	id: string;
	object: "model";
	created: number;
	owned_by: string;
	architecture: {
		modality: string;
		input_modalities: string[];
		output_modalities: string[];
	};
	top_provider: {
		context_length?: number | null;
		max_completion_tokens?: number | null;
	};
	/** USD per token (or per search unit), the cheapest rate in the pool. */
	pricing: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
		search_unit?: string;
	};
	operations: Array<{ id: BoelabsGatewayOperationId; endpoints: string[] }>;
	supported_parameters: string[];
	/** `model:mode` suffixes at least one deployment serves. */
	service_modes?: Array<"fast" | "flex" | "priority">;
	text_capabilities?: {
		contracts: Array<"chat.completions" | "responses" | "messages">;
		supported_parameters: string[];
		parameter_constraints: Record<string, BoelabsGatewayParameterConstraint>;
		input_modalities: string[];
		reasoning_efforts: string[];
		max_output_tokens?: number;
	};
	image_capabilities?: {
		generate?: BoelabsGatewayImageOperationCapabilities;
		edit?: BoelabsGatewayImageOperationCapabilities;
	};
	video_capabilities?: {
		tasks: string[];
		durations: string[];
		sizes?: Array<{ size: string; aspect_ratio?: string; resolution?: string }>;
		qualities: string[];
		seed: boolean;
		generate_audio: boolean;
		input_references: {
			image: boolean;
			video: boolean;
			audio: boolean;
			frame_images: boolean;
			max?: number;
		};
	};
	embedding_capabilities?: {
		dimensions?: { min: number; max?: number };
		encoding_formats: string[];
		max_inputs?: number;
	};
	transcription_capabilities?: {
		response_formats: string[];
		timestamp_granularities: Array<"word" | "segment">;
	};
	/** How many deployments back this model. */
	endpoint_count: number;
}

/** One deployment behind a public model, with its live routing metrics. */
export interface BoelabsGatewayModelDeployment {
	id: string;
	object: "model.deployment";
	model: string;
	provider: string;
	status: "available" | "cooldown" | "half_open" | "rate_limited";
	retry_after_ms: number | null;
	created: number;
	weight: number;
	limits: { rpm: number | null; tpm: number | null };
	top_provider: BoelabsGatewayModel["top_provider"];
	pricing: BoelabsGatewayModel["pricing"];
	operations: BoelabsGatewayModel["operations"];
	supported_parameters: string[];
	service_modes?: BoelabsGatewayModel["service_modes"];
	transports: Record<string, string>;
	metrics: {
		inflight: number;
		rpm: number;
		tpm: number;
		health_score: number;
		latency_ms: number | null;
		throughput_tps: number | null;
	};
}

export interface BoelabsGatewayRequestOptions {
	abortSignal?: AbortSignal;
	headers?: Record<string, string | undefined>;
}

export interface BoelabsGatewayListModelsOptions
	extends BoelabsGatewayRequestOptions {
	/** Keep only models that serve this operation, e.g. `"video.generate"`. */
	operation?: BoelabsGatewayOperationId;
}

/** The gateway's model catalog. Discovery is public: no API key is needed for it. */
export interface BoelabsGatewayModels {
	/** Every enabled public model (`GET /v1/models`). */
	list: (
		options?: BoelabsGatewayListModelsOptions,
	) => Promise<BoelabsGatewayModel[]>;
	/** One public model (`GET /v1/models/{model}`). */
	get: (
		modelId: string,
		options?: BoelabsGatewayRequestOptions,
	) => Promise<BoelabsGatewayModel>;
	/** Deployments behind a public model, with live metrics; needs an API key. */
	deployments: (
		modelId: string,
		options?: BoelabsGatewayRequestOptions,
	) => Promise<BoelabsGatewayModelDeployment[]>;
}

// The gateway owns these shapes; they are typed, not validated, so new fields never break a client.
const listSchema = jsonSchema<{ data: BoelabsGatewayModel[] }>({
	type: "object",
});
const modelSchema = jsonSchema<BoelabsGatewayModel>({ type: "object" });
const deploymentsSchema = jsonSchema<{ data: BoelabsGatewayModelDeployment[] }>(
	{
		type: "object",
	},
);

export function createModels(
	config: () => BoelabsGatewayConfig,
): BoelabsGatewayModels {
	const get = async <T>(
		path: string,
		schema: Parameters<typeof createJsonResponseHandler<T>>[0],
		options: BoelabsGatewayRequestOptions | undefined,
	): Promise<T> => {
		const resolved = config();
		const { value } = await getFromApi({
			url: apiUrl(resolved, path),
			headers: requestHeaders(resolved, options?.headers),
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(schema),
			validateUrl: false,
			...transport(resolved, options?.abortSignal),
		});
		return value;
	};

	return {
		async list(options) {
			const { data } = await get("/models", listSchema, options);
			const operation = options?.operation;
			return operation === undefined
				? data
				: data.filter((model) =>
						(model.operations ?? []).some((entry) => entry.id === operation),
					);
		},
		get(modelId, options) {
			return get(
				`/models/${encodeURIComponent(modelId)}`,
				modelSchema,
				options,
			);
		},
		async deployments(modelId, options) {
			const { data } = await get(
				`/models/${encodeURIComponent(modelId)}/deployments`,
				deploymentsSchema,
				options,
			);
			return data;
		},
	};
}
