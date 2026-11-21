import { combineHeaders, withUserAgentSuffix } from "@ai-sdk/provider-utils";
import type { FetchFunction } from "@ai-sdk/provider-utils";

/** What every model needs to reach the gateway. Built once per provider instance. */
export interface BoelabsGatewayConfig {
	/** `<provider name>.<surface>`, e.g. `boelabsGateway.responses`. */
	provider: string;
	/** Namespaces read from `providerOptions`, in merge order. */
	providerOptionsNames: readonly string[];
	/** Key under which results expose `providerMetadata`. */
	providerMetadataName: string;
	/** Absolute URL of a gateway API path (`/responses` → `https://…/v1/responses`). */
	url: (path: string) => string;
	headers: () => Record<string, string | undefined>;
	/** Appended to the `user-agent` of every request. */
	userAgent: string;
	fetch?: FetchFunction | undefined;
	generateId?: (() => string) | undefined;
}

export function apiUrl(config: BoelabsGatewayConfig, path: string): string {
	return config.url(path);
}

/** `abortSignal` and `fetch` for the provider-utils request helpers, without undefined keys. */
export function transport(
	config: BoelabsGatewayConfig,
	abortSignal: AbortSignal | undefined,
): { abortSignal?: AbortSignal; fetch?: FetchFunction } {
	return {
		...(abortSignal === undefined ? {} : { abortSignal }),
		...(config.fetch === undefined ? {} : { fetch: config.fetch }),
	};
}

/** Provider headers, then per-call ones, with the provider's user-agent suffix last. */
export function requestHeaders(
	config: BoelabsGatewayConfig,
	...headers: Array<Record<string, string | undefined> | undefined>
): Record<string, string> {
	return withUserAgentSuffix(
		combineHeaders(config.headers(), ...headers),
		config.userAgent,
	);
}
