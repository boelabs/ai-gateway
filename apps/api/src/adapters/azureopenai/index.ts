import type { Adapter, ProviderModule } from "#adapters/types.ts";
import { makeAzureTranscriptionHandler } from "./audio.ts";
import { makeOpenAIDecisionsHandler } from "#adapters/decisions.ts";

import {
	normalizeAzurev1BaseUrl,
	azureRefineBadRequest,
	makeAzurev1Adapter,
} from "#adapters/azurev1.ts";

const LABEL = "Azure OpenAI v1";

/** Chat, Responses, and embeddings use Azure's OpenAI-compatible v1 surface. */
const base = makeAzurev1Adapter({
	key: "azureopenai",
	label: LABEL,
	defaultTransport: "responses",
	supportedChatTransports: ["responses", "chat_completions"],
	supportsDeveloperRole: true,
	contentInputs: {
		responses: {
			file: {
				sources: ["provider_file_id", "data_url"],
				maxBytes: 50_000_000,
			},
		},
		chat_completions: {
			file: {
				sources: ["provider_file_id", "data_url"],
				maxBytes: 50_000_000,
			},
		},
	},
	embeddings: true,
	// POST {endpoint}/openai/v1/images/{generations,edits}
	imageTransports: ["images"],
	defaultImageTransport: "images",
});

/** Azure OpenAI with classic audio transcriptions and an explicit v1 audio opt-in. */
export const azureopenaiAdapter: Adapter = {
	...base,
	supportedCallTypes: new Set([
		...base.supportedCallTypes,
		"audio.transcriptions",
		"decisions",
	]),
	audioTranscription: makeAzureTranscriptionHandler(LABEL),
	// POST {endpoint}/openai/v1/decisions; `model` is the Azure deployment name.
	decisions: makeOpenAIDecisionsHandler({
		label: LABEL,
		authScheme: "api-key",
		normalizeBaseUrl: normalizeAzurev1BaseUrl,
		dialect: "azure",
		refineBadRequest: azureRefineBadRequest,
	}),
	transports: {
		...base.transports,
		"audio.transcriptions": {
			supported: ["azure_audio_transcriptions_legacy", "audio_transcriptions"],
			default: "azure_audio_transcriptions_legacy",
		},
		decisions: { supported: ["openai_decisions"], default: "openai_decisions" },
	},
	// Up to 128 PNG, JPEG, WebP or GIF images per request, 32 MB together.
	contentInputs: {
		...base.contentInputs,
		openai_decisions: {
			image: {
				sources: ["url", "data_url"],
				mimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
				maxBytes: 32_000_000,
			},
		},
	},
};

export const azureopenaiProvider: ProviderModule = {
	adapter: azureopenaiAdapter,
};
