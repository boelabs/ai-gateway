import { gatewayOptionsShape } from "../shared/gateway-options.ts";
import { z } from "zod/v4";

export const REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type BoelabsGatewayReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Options shared by both text surfaces. */
export const textOptionsShape = {
	...gatewayOptionsShape,
	/**
	 * Reasoning effort on the gateway's ladder. Overrides the AI SDK's `reasoning` setting; the
	 * gateway snaps it onto what the served model supports instead of rejecting it.
	 */
	reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
	/** Persist the response on the gateway (`store`). Omitted, the gateway's default applies. */
	store: z.boolean().optional(),
	/** Key-value metadata stored with the request. */
	metadata: z.record(z.string(), z.string()).optional(),
	/** Allow several tool calls in one step. */
	parallelToolCalls: z.boolean().optional(),
	/** Upstream service tier (`auto`, `default`, `flex`, `priority`, …). Prefer `serviceMode`. */
	serviceTier: z.string().optional(),
	/** Stable end-user identifier for abuse detection. */
	safetyIdentifier: z.string().optional(),
	/** End-user identifier (OpenAI's `user`). */
	user: z.string().optional(),
	/** Groups requests that share a prompt prefix so providers can reuse their cache. */
	promptCacheKey: z.string().optional(),
	/** How long a provider keeps a cached prefix (`in_memory` or `24h`). */
	promptCacheRetention: z.enum(["in_memory", "24h"]).optional(),
	/** Caching policy for models with explicit breakpoints. */
	promptCacheOptions: z
		.object({
			mode: z.enum(["implicit", "explicit"]).optional(),
			ttl: z.literal("30m").optional(),
		})
		.optional(),
	/** Output verbosity on models that support it. */
	textVerbosity: z.enum(["low", "medium", "high"]).optional(),
	/**
	 * Send `strict: true` with JSON schemas (structured outputs) and function tools. The gateway
	 * then routes only to deployments that guarantee schema adherence. Default `false`.
	 */
	strictJsonSchema: z.boolean().optional(),
	/**
	 * Log probabilities: `true` for the chosen tokens, or a number (0–20) of alternatives per token.
	 * Returned in `providerMetadata.<name>.logprobs`.
	 */
	logprobs: z.union([z.boolean(), z.number().int().min(0).max(20)]).optional(),
};

export const responsesOptionsSchema = z.object({
	...textOptionsShape,
	/** Visible reasoning: `auto`, `concise`, `detailed`, or `none` (hidden). The gateway uses `auto` whenever an effort is set. */
	reasoningSummary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
	/** Continue a stored response; only the new messages are sent. Requires `store: true` earlier. */
	previousResponseId: z.string().optional(),
	/** Instructions sent as the request's `instructions` field instead of a system message. */
	instructions: z.string().optional(),
	/** Extra `include` values; `reasoning.encrypted_content` is always requested. */
	include: z.array(z.string()).optional(),
	/** `auto` lets the provider drop the middle of a context that is too long. */
	truncation: z.enum(["auto", "disabled"]).optional(),
	/** Context management entries (`compaction`, …), passed through. */
	contextManagement: z.array(z.record(z.string(), z.unknown())).optional(),
	/** How system messages are sent: as `system` (default) or `developer` input messages. */
	systemMessageMode: z.enum(["system", "developer"]).optional(),
});

export type BoelabsGatewayResponsesOptions = z.input<
	typeof responsesOptionsSchema
>;

/** Per-part options on prompt content. */
export const partOptionsSchema = z.object({
	/** Image detail for vision models. */
	imageDetail: z.enum(["auto", "low", "high"]).optional(),
	/** Marks the end of a cacheable prefix on models with explicit breakpoints. */
	promptCacheBreakpoint: z
		.union([z.literal(true), z.object({ mode: z.literal("explicit") })])
		.optional(),
});

/** What a reasoning or text part carries back so the gateway can restore provider state. */
export const itemOptionsSchema = z.object({
	itemId: z.string().nullish(),
	reasoningEncryptedContent: z.string().nullish(),
	phase: z.string().nullish(),
});
