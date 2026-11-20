import { makeAzureSystemOneDecisionsHandler } from "#adapters/decisions.ts";
import type { Adapter, ProviderModule } from "#adapters/types.ts";

import {
	normalizeAzurev1BaseUrl,
	azureRefineBadRequest,
	makeAzurev1Adapter,
} from "#adapters/azurev1.ts";

const LABEL = "Azure Foundry";

/** Foundry models sold by Azure: Chat Completions upstream; Responses is rendered locally. */
const base = makeAzurev1Adapter({
	key: "azurefoundry",
	label: LABEL,
	defaultTransport: "chat_completions",
	supportedChatTransports: ["chat_completions"],
});

/** Foundry plus the Microsoft-Decision models, served on the resource's SystemOne path. */
export const azurefoundryAdapter: Adapter = {
	...base,
	supportedCallTypes: new Set([...base.supportedCallTypes, "decisions"]),
	decisions: makeAzureSystemOneDecisionsHandler({
		label: LABEL,
		normalizeBaseUrl: normalizeAzurev1BaseUrl,
		refineBadRequest: azureRefineBadRequest,
	}),
	transports: {
		...base.transports,
		decisions: { supported: ["systemone"], default: "systemone" },
	},
	// Base64 assets; Microsoft documents PNG and publishes no size or count limit.
	contentInputs: {
		...base.contentInputs,
		systemone: {
			image: { sources: ["data_url"], mimeTypes: ["image/png", "image/jpeg"] },
		},
	},
};

export const azurefoundryProvider: ProviderModule = {
	adapter: azurefoundryAdapter,
};
