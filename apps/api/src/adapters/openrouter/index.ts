import { makeOpenRouterDecisionsHandler } from "#adapters/decisions.ts";
import type { Adapter, ProviderModule } from "#adapters/types.ts";
import { makeOpenRouterRerankHandler } from "./rerank.ts";

export const openrouterAdapter = {
	key: "openrouter",
	credentials: { required: ["apiKey"] },
	supportedCallTypes: new Set(["rerank", "decisions"]),
	rerank: makeOpenRouterRerankHandler(),
	decisions: makeOpenRouterDecisionsHandler(),
	transports: {
		rerank: {
			supported: ["openrouter_rerank"],
			default: "openrouter_rerank",
		},
		decisions: {
			supported: ["openrouter_decisions"],
			default: "openrouter_decisions",
		},
	},
	// Images travel as base64 assets; OpenRouter does not fetch URLs for every decision provider.
	contentInputs: {
		openrouter_decisions: {
			image: { sources: ["data_url"], mimeTypes: ["image/png", "image/jpeg"] },
		},
	},
} satisfies Adapter;

export const openrouterProvider: ProviderModule = {
	adapter: openrouterAdapter,
};
