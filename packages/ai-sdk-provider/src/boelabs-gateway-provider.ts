import { BoelabsGatewayResponsesLanguageModel } from "./responses/responses-language-model.ts";
import { BoelabsGatewayTranscriptionModel } from "./media/transcription-model.ts";
import { BoelabsGatewayChatLanguageModel } from "./chat/chat-language-model.ts";
import { BoelabsGatewayEmbeddingModel } from "./media/embedding-model.ts";
import { BoelabsGatewayRerankingModel } from "./media/reranking-model.ts";
import { type BoelabsGatewayModels, createModels } from "./models.ts";
import { BoelabsGatewaySpeechModel } from "./media/speech-model.ts";
import { BoelabsGatewayVideoModel } from "./media/video-model.ts";
import { BoelabsGatewayImageModel } from "./media/image-model.ts";
import type { BoelabsGatewayConfig } from "./shared/config.ts";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import { VERSION } from "./version.ts";

import type {
	Experimental_VideoModelV4 as VideoModelV4,
	TranscriptionModelV4,
	EmbeddingModelV4,
	RerankingModelV4,
	LanguageModelV4,
	SpeechModelV4,
	ImageModelV4,
	ProviderV4,
} from "@ai-sdk/provider";

import {
	withoutTrailingSlash,
	loadOptionalSetting,
	loadSetting,
	loadApiKey,
} from "@ai-sdk/provider-utils";

/**
 * A public model name on your gateway: an alias the operator chose (`general`, `fast`) or a
 * catalog id, optionally with a service mode (`gpt-6.1-sol:flex`). List them with
 * `provider.models.list()`.
 */
export type BoelabsGatewayModelId = string;

export interface BoelabsGatewayProviderSettings {
	/**
	 * Gateway origin, e.g. `https://ai.example.com`. `/v1` is added unless the URL already ends in
	 * it. Defaults to the `BOELABS_AI_GATEWAY_URL` environment variable.
	 */
	baseURL?: string | undefined;
	/** Virtual or master key. Defaults to the `BOELABS_AI_GATEWAY_API_KEY` environment variable. */
	apiKey?: string | undefined;
	/** Headers sent with every request. */
	headers?: Record<string, string> | undefined;
	/**
	 * Text API behind `provider(modelId)` and `provider.languageModel(modelId)`: the Responses API
	 * (default) or Chat Completions. `provider.responses()` and `provider.chat()` pick one directly.
	 */
	textApi?: "responses" | "chat" | undefined;
	/**
	 * Provider name: the prefix of `model.provider`, the key of `providerMetadata`, and a second
	 * `providerOptions` namespace read after `boelabsGateway`. Defaults to `boelabsGateway`.
	 */
	name?: string | undefined;
	/** Custom fetch, e.g. for proxies, tests or request logging. */
	fetch?: FetchFunction | undefined;
	/** Id generator for sources and tool calls without one. */
	generateId?: (() => string) | undefined;
}

export interface BoelabsGatewayProvider extends ProviderV4 {
	/** A language model on the configured text API (Responses by default). */
	(modelId: BoelabsGatewayModelId): LanguageModelV4;
	/** A language model on the configured text API (Responses by default). */
	languageModel: (modelId: BoelabsGatewayModelId) => LanguageModelV4;
	/** A language model on `/v1/responses`. */
	responses: (modelId: BoelabsGatewayModelId) => LanguageModelV4;
	/** A language model on `/v1/chat/completions`. */
	chat: (modelId: BoelabsGatewayModelId) => LanguageModelV4;
	/** An embedding model on `/v1/embeddings`. */
	embedding: (modelId: BoelabsGatewayModelId) => EmbeddingModelV4;
	/** An embedding model on `/v1/embeddings`. */
	embeddingModel: (modelId: BoelabsGatewayModelId) => EmbeddingModelV4;
	/** An image model on `/v1/images/generations` and `/v1/images/edits`. */
	image: (modelId: BoelabsGatewayModelId) => ImageModelV4;
	/** An image model on `/v1/images/generations` and `/v1/images/edits`. */
	imageModel: (modelId: BoelabsGatewayModelId) => ImageModelV4;
	/** A transcription model on `/v1/audio/transcriptions`. */
	transcription: (modelId: BoelabsGatewayModelId) => TranscriptionModelV4;
	/** A transcription model on `/v1/audio/transcriptions`. */
	transcriptionModel: (modelId: BoelabsGatewayModelId) => TranscriptionModelV4;
	/** A speech model on `/v1/audio/speech`. */
	speech: (modelId: BoelabsGatewayModelId) => SpeechModelV4;
	/** A speech model on `/v1/audio/speech`. */
	speechModel: (modelId: BoelabsGatewayModelId) => SpeechModelV4;
	/** A reranking model on `/v1/rerank`. */
	reranking: (modelId: BoelabsGatewayModelId) => RerankingModelV4;
	/** A reranking model on `/v1/rerank`. */
	rerankingModel: (modelId: BoelabsGatewayModelId) => RerankingModelV4;
	/** A video model on `/v1/videos` (for `experimental_generateVideo`). */
	video: (modelId: BoelabsGatewayModelId) => VideoModelV4;
	/** A video model on `/v1/videos` (for `experimental_generateVideo`). */
	videoModel: (modelId: BoelabsGatewayModelId) => VideoModelV4;
	/** The gateway's model catalog. */
	models: BoelabsGatewayModels;
}

/** `https://gw.example.com` and `https://gw.example.com/v1` both address `…/v1`. */
function apiBase(baseURL: string): string {
	const trimmed = withoutTrailingSlash(baseURL) ?? baseURL;
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/** Creates a provider for a Boelabs AI Gateway. */
export function createBoelabsGateway(
	settings: BoelabsGatewayProviderSettings = {},
): BoelabsGatewayProvider {
	const name = settings.name ?? "boelabsGateway";
	const providerOptionsNames = [...new Set(["boelabsGateway", name])];

	const url = (path: string) =>
		`${apiBase(
			loadSetting({
				settingValue: settings.baseURL,
				environmentVariableName: "BOELABS_AI_GATEWAY_URL",
				settingName: "baseURL",
				description: "Boelabs AI Gateway URL",
			}),
		)}${path}`;

	const userAgent = `ai-sdk/boelabs-gateway/${VERSION}`;
	const headers = () => ({
		Authorization: `Bearer ${loadApiKey({
			apiKey: settings.apiKey,
			environmentVariableName: "BOELABS_AI_GATEWAY_API_KEY",
			description: "Boelabs AI Gateway",
		})}`,
		...settings.headers,
	});

	const config = (surface: string): BoelabsGatewayConfig => ({
		provider: `${name}.${surface}`,
		providerOptionsNames,
		providerMetadataName: name,
		url,
		headers,
		userAgent,
		fetch: settings.fetch,
		generateId: settings.generateId,
	});

	// Discovery is unauthenticated: send the key only when one is configured.
	const catalogConfig = (): BoelabsGatewayConfig => ({
		...config("models"),
		headers: () => {
			const apiKey = loadOptionalSetting({
				settingValue: settings.apiKey,
				environmentVariableName: "BOELABS_AI_GATEWAY_API_KEY",
			});
			return {
				...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
				...settings.headers,
			};
		},
	});

	const responses = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayResponsesLanguageModel(modelId, config("responses"));
	const chat = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayChatLanguageModel(modelId, config("chat"));
	const languageModel = (modelId: BoelabsGatewayModelId): LanguageModelV4 =>
		settings.textApi === "chat" ? chat(modelId) : responses(modelId);
	const embedding = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayEmbeddingModel(modelId, config("embedding"));
	const image = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayImageModel(modelId, config("image"));
	const transcription = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayTranscriptionModel(modelId, config("transcription"));
	const speech = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewaySpeechModel(modelId, config("speech"));
	const reranking = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayRerankingModel(modelId, config("reranking"));
	const video = (modelId: BoelabsGatewayModelId) =>
		new BoelabsGatewayVideoModel(modelId, config("video"));

	const provider = (modelId: BoelabsGatewayModelId) => {
		if (new.target) {
			throw new Error(
				"The Boelabs provider function cannot be called with the new keyword.",
			);
		}
		return languageModel(modelId);
	};

	return Object.assign(provider, {
		specificationVersion: "v4" as const,
		languageModel,
		responses,
		chat,
		embedding,
		embeddingModel: embedding,
		image,
		imageModel: image,
		transcription,
		transcriptionModel: transcription,
		speech,
		speechModel: speech,
		reranking,
		rerankingModel: reranking,
		video,
		videoModel: video,
		models: createModels(catalogConfig),
	});
}

/**
 * The default provider, configured from `BOELABS_AI_GATEWAY_URL` and `BOELABS_AI_GATEWAY_API_KEY`. Both are read
 * when a request is made, not on import.
 */
export const boelabsGateway: BoelabsGatewayProvider = createBoelabsGateway();
