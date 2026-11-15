import type { CanonicalChatRequest } from "#core/canonical.ts";

import {
	assertServiceTierAgrees,
	type ServiceMode,
} from "#core/serviceMode.ts";

/**
 * OpenAI renamed Priority processing to Fast mode (2026-07-30) and accepts either value for it, so
 * `:fast` and `:priority` are the same tier there. The response names the tier it actually used
 * (`priority` for GPT-5.6 and earlier, `default` when a ramp limit downgraded the request), which is
 * what the cost calculation bills.
 */
const EQUIVALENT_TIERS: Partial<Record<ServiceMode, readonly string[]>> = {
	fast: ["fast", "priority"],
	priority: ["priority", "fast"],
	flex: ["flex"],
};

export const OPENAI_SERVICE_MODES: ReadonlySet<ServiceMode> = new Set([
	"fast",
	"priority",
	"flex",
]);

/**
 * Sends the slug's mode as `service_tier`. Both body builders (Chat Completions and Responses) read
 * the chat transport's tier when the request carries no Responses one, so that is the one set.
 */
export function withOpenAIServiceMode(
	req: CanonicalChatRequest,
	mode: ServiceMode | undefined,
): CanonicalChatRequest {
	if (mode === undefined) {
		return req;
	}
	assertServiceTierAgrees(
		mode,
		req.responsesTransport?.serviceTier ?? req.chatTransport?.serviceTier,
		EQUIVALENT_TIERS,
	);
	return {
		...req,
		chatTransport: { ...req.chatTransport, serviceTier: mode },
		...(req.responsesTransport
			? { responsesTransport: { ...req.responsesTransport, serviceTier: mode } }
			: {}),
	};
}
