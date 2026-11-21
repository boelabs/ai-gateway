import { resolveProviderOptions } from "@ai-sdk/provider-utils";
import type { FlexibleSchema } from "@ai-sdk/provider-utils";
import type { JSONObject } from "@ai-sdk/provider";
import { isRecord, toJSONObject } from "./json.ts";
import { z } from "zod/v4";

/** Service modes the gateway serves through a `model:mode` suffix. */
export const SERVICE_MODES = ["fast", "flex", "priority"] as const;
export type BoelabsGatewayServiceMode = (typeof SERVICE_MODES)[number];

/**
 * Options the gateway reads on every surface. Each one is a header, a model suffix or a
 * passthrough body field, so they behave the same on every model type.
 */
export const gatewayOptionsShape = {
	/**
	 * Response cache (`x-unified-cache`). `true` uses the gateway's default TTL (300 s); an object
	 * sets it (1–86400 s). Applies to text and embeddings; streamed and tool calls are never cached.
	 */
	cache: z
		.union([
			z.boolean(),
			z.object({ ttl: z.number().int().min(1).max(86_400).optional() }),
		])
		.optional(),
	/** Adds the gateway's routing report (`x-unified-routing-metadata`) to `providerMetadata`. */
	routingMetadata: z.boolean().optional(),
	/** Request id echoed by the gateway (`x-request-id`); generated when omitted. */
	requestId: z.string().optional(),
	/** Service mode, sent as the `model:mode` suffix. Refused by the gateway when no deployment serves it. */
	serviceMode: z.enum(SERVICE_MODES).optional(),
	/** Provider-specific fields merged into the upstream body (`extra_body`). */
	extraBody: z.record(z.string(), z.unknown()).optional(),
};

export interface GatewayOptions {
	cache?: boolean | { ttl?: number | undefined } | undefined;
	routingMetadata?: boolean | undefined;
	requestId?: string | undefined;
	serviceMode?: BoelabsGatewayServiceMode | undefined;
	extraBody?: Record<string, unknown> | undefined;
}

export const gatewayOptionsSchema = z.object(gatewayOptionsShape);

/** Parses `providerOptions` under every namespace the provider answers to, later ones winning. */
export async function parseOptions<T>(
	providerOptions: Record<string, unknown> | undefined,
	namespaces: readonly string[],
	schema: FlexibleSchema<T>,
): Promise<T | undefined> {
	const { options } = await resolveProviderOptions({
		providerOptions,
		namespaces,
		resolution: "merge",
		schema,
	});
	return options;
}

export function gatewayHeaders(
	options: GatewayOptions | undefined,
): Record<string, string | undefined> {
	if (options === undefined) {
		return {};
	}
	const headers: Record<string, string | undefined> = {};
	if (options.cache !== undefined && options.cache !== false) {
		headers["x-unified-cache"] = "true";
		if (typeof options.cache === "object" && options.cache.ttl !== undefined) {
			headers["x-unified-cache-ttl"] = String(options.cache.ttl);
		}
	}
	if (options.routingMetadata === true) {
		headers["x-unified-routing-metadata"] = "true";
	}
	if (options.requestId !== undefined) {
		headers["x-request-id"] = options.requestId;
	}
	return headers;
}

/** The model as sent on the wire: the public name, plus a service-mode suffix when asked for. */
export function wireModelId(
	modelId: string,
	serviceMode: BoelabsGatewayServiceMode | undefined,
): string {
	if (serviceMode === undefined || modelId.endsWith(`:${serviceMode}`)) {
		return modelId;
	}
	return `${modelId}:${serviceMode}`;
}

/**
 * Gateway facts every result carries in `providerMetadata`: the request id from the response
 * headers and, when asked for, the routing report from the body.
 */
export function gatewayMetadata(
	headers: Record<string, string> | undefined,
	body?: unknown,
): JSONObject {
	const metadata: JSONObject = {};
	const requestId = headers?.["x-request-id"];
	if (requestId !== undefined) {
		metadata.requestId = requestId;
	}
	if (isRecord(body) && isRecord(body.unified_routing)) {
		metadata.routing = toJSONObject(body.unified_routing);
	}
	return metadata;
}
