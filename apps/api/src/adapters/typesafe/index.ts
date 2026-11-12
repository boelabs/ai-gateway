import { makeSystemOneDecisionsHandler } from "#adapters/decisions.ts";
import type { Adapter, ProviderModule } from "#adapters/types.ts";

/**
 * TypeSafe, the maker of the Jev decision models: one protocol, `POST /v1/systemone`. Images go as
 * base64 assets (PNG or JPEG, up to 16 MiB each); a deployment that needs Jev's long context sends
 * `TypeSafe-Danger-Zone-Long-Context: true` through `credentials.headers`.
 */
export const typesafeAdapter = {
	key: "typesafe",
	credentials: { required: ["apiKey"] },
	supportedCallTypes: new Set(["decisions"]),
	decisions: makeSystemOneDecisionsHandler(),
	transports: {
		decisions: { supported: ["systemone"], default: "systemone" },
	},
	contentInputs: {
		systemone: {
			image: {
				sources: ["data_url"],
				mimeTypes: ["image/png", "image/jpeg"],
				maxBytes: 16 * 1024 * 1024,
			},
		},
	},
} satisfies Adapter;

export const typesafeProvider: ProviderModule = { adapter: typesafeAdapter };
