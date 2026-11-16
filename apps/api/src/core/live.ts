import type { Usage } from "./usage.ts";

/**
 * GPT-Live: OpenAI's full-duplex voice sessions (`/v1/live/sessions`). The public contract is
 * OpenAI's own, relayed as is: the gateway authenticates, routes `session.model` to a deployment,
 * rewrites the model name between public and upstream, and meters the session. It does not translate
 * the protocol, so only providers that speak it (OpenAI, Azure OpenAI) serve it.
 */

export const LIVE_DELEGATION_TYPES = [
	"client",
	"responses",
	"decisions",
] as const;
export type LiveDelegationType = (typeof LIVE_DELEGATION_TYPES)[number];

export const LIVE_TRANSPORTS = ["websocket", "webrtc", "sip"] as const;
export type LiveTransport = (typeof LIVE_TRANSPORTS)[number];

/** What a live model accepts, checked against `session.start` before routing. */
export interface LiveProfile {
	/** Documented voices, for discovery. Not enforced: custom voices are `{ id }`. */
	voices?: string[];
	/** Delegation types it accepts. Absent: all of them. */
	delegationTypes?: LiveDelegationType[];
	/** How sessions may be opened. Absent: all of them. */
	transports?: LiveTransport[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/** The delegation type a session config selects; omitted or null is client delegation. */
export function liveDelegationType(session: Record<string, unknown>): string {
	const delegation = record(session.delegation);
	return typeof delegation?.type === "string" ? delegation.type : "client";
}

/**
 * The backend models a session (or a `session.update`) hands work to: the Responses model and the
 * decisions model. The gateway bills their usage too, so each must be a model it can price.
 */
export function liveDelegatedModels(
	session: Record<string, unknown>,
): string[] {
	const delegation = record(session.delegation);
	const models = [
		record(delegation?.responses)?.model,
		record(delegation?.decisions)?.model,
	];
	return models.filter((model): model is string => typeof model === "string");
}

/** Work a session delegated to a backend model, priced against that model. */
export interface LiveDelegatedUsage {
	model: string;
	usage: Usage;
}

/** OpenAI Responses/Decisions usage JSON -> canonical usage. */
function tokenUsage(raw: unknown, serviceTier?: unknown): Usage | undefined {
	const usage = record(raw);
	if (!usage) {
		return undefined;
	}
	const input = count(usage.input_tokens);
	const output = count(usage.output_tokens);
	const inputDetails = record(usage.input_tokens_details);
	const outputDetails = record(usage.output_tokens_details);
	const cached = count(inputDetails?.cached_tokens);
	const reasoning = count(outputDetails?.reasoning_tokens);
	return {
		promptTokens: input,
		completionTokens: output,
		totalTokens: input + output,
		...(cached ? { cacheReadTokens: cached } : {}),
		...(reasoning ? { reasoningTokens: reasoning } : {}),
		...(typeof serviceTier === "string" && serviceTier !== "default"
			? { serviceTier }
			: {}),
	};
}

/**
 * Follows a live session's server events for what it costs: the session seconds (cumulative, so the
 * latest figure replaces the previous one) and each backend response or decision, counted once.
 */
export class LiveUsageMeter {
	seconds = 0;
	/** The session reported its final usage (`session.closed`). */
	closed = false;
	readonly delegated: LiveDelegatedUsage[] = [];
	private readonly counted = new Set<string>();
	private responsesModel: string | undefined;

	constructor(responsesModel: string | undefined) {
		this.responsesModel = responsesModel;
	}

	/** The Responses model the session currently delegates to (it may change with session.update). */
	delegateTo(model: string | undefined): void {
		if (model) {
			this.responsesModel = model;
		}
	}

	/** Reads one server event. Returns true when the billable usage changed. */
	observe(event: Record<string, unknown>): boolean {
		switch (event.type) {
			case "session.usage.updated":
			case "session.closed": {
				if (event.type === "session.closed") {
					this.closed = true;
				}
				const seconds = count(record(event.usage)?.seconds);
				if (seconds > this.seconds) {
					this.seconds = seconds;
					return true;
				}
				return false;
			}
			case "response.event": {
				const nested = record(event.event);
				const response = record(nested?.response);
				if (nested?.type !== "response.completed" || !response) {
					return false;
				}
				return this.add(
					`response:${String(response.id ?? event.event_id)}`,
					typeof response.model === "string"
						? response.model
						: this.responsesModel,
					tokenUsage(response.usage, response.service_tier),
				);
			}
			case "decision.event": {
				const decision = record(record(event.event)?.decision);
				return this.add(
					`decision:${String(event.event_id)}`,
					typeof decision?.model === "string" ? decision.model : undefined,
					tokenUsage(decision?.usage),
				);
			}
			default:
				return false;
		}
	}

	private add(
		key: string,
		model: string | undefined,
		usage: Usage | undefined,
	): boolean {
		if (!(model && usage) || this.counted.has(key)) {
			return false;
		}
		this.counted.add(key);
		this.delegated.push({ model, usage });
		return true;
	}
}
