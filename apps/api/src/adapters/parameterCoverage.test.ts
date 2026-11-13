import type { CanonicalChatRequest } from "#core/canonical.ts";
import { withAdapterParameters } from "#catalog/parameters.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import type { AdapterContext } from "./types.ts";
import { GatewayError } from "#core/errors.ts";
import { listAdapters } from "./registry.ts";
import { MODEL_CATALOG } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * C0: every canonical request field an adapter accepts must reach the upstream, be rejected with a
 * typed error, or be declared `unsupported`/`ignored` in the model's catalog entry so the parameter
 * policy drops it and records it. A field that changes nothing in the upstream request while the
 * catalog says nothing about it is accepted and silently lost, which this test forbids.
 */

const BASE: CanonicalChatRequest = {
	callType: "chat",
	model: "m",
	stream: false,
	messages: [{ role: "user", content: "hi" }],
};

const TOOLS: CanonicalChatRequest["tools"] = [
	{
		name: "lookup",
		description: "Looks something up",
		parameters: { type: "object", properties: { q: { type: "string" } } },
	},
];

interface Probe {
	field: keyof CanonicalChatRequest;
	names: readonly string[];
	/** The request the probe is compared against. */
	base?: Partial<CanonicalChatRequest>;
	value: Partial<CanonicalChatRequest>;
}

const PROBES: readonly Probe[] = [
	{
		field: "temperature",
		names: ["temperature"],
		value: { temperature: 0.37 },
	},
	{ field: "topP", names: ["top_p"], value: { topP: 0.37 } },
	{ field: "topK", names: ["top_k"], value: { topK: 37 } },
	{
		field: "maxTokens",
		names: ["max_tokens", "max_completion_tokens"],
		value: { maxTokens: 3737 },
	},
	{ field: "stop", names: ["stop"], value: { stop: ["zz-stop"] } },
	{ field: "n", names: ["n"], value: { n: 3 } },
	{
		field: "presencePenalty",
		names: ["presence_penalty"],
		value: { presencePenalty: 0.37 },
	},
	{
		field: "frequencyPenalty",
		names: ["frequency_penalty"],
		value: { frequencyPenalty: 0.37 },
	},
	{ field: "seed", names: ["seed"], value: { seed: 3737 } },
	{ field: "user", names: ["user"], value: { user: "zz-user" } },
	{ field: "tools", names: ["tools"], value: { tools: TOOLS } },
	{
		field: "toolChoice",
		names: ["tool_choice"],
		base: { tools: TOOLS },
		value: { tools: TOOLS, toolChoice: { name: "lookup" } },
	},
	{
		field: "parallelToolCalls",
		names: ["parallel_tool_calls"],
		base: { tools: TOOLS },
		value: { tools: TOOLS, parallelToolCalls: false },
	},
	{
		field: "responseFormat",
		names: ["response_format", "structured_outputs"],
		value: {
			responseFormat: {
				type: "json_schema",
				name: "answer",
				schema: { type: "object", properties: { a: { type: "string" } } },
			},
		},
	},
	// The highest effort, against the default (the lowest). A model with a single reasoning level has
	// nothing to choose, so the probe skips it.
	{
		field: "reasoning",
		names: ["reasoning", "reasoning_effort"],
		value: { reasoning: { effort: "xhigh" } },
	},
	{
		field: "promptCacheKey",
		names: ["prompt_cache_key"],
		value: { promptCacheKey: "zz-cache-key" },
	},
	{
		field: "promptCachePolicy",
		names: ["prompt_cache_options"],
		value: { promptCachePolicy: { mode: "explicit", minimumTtlSeconds: 3600 } },
	},
	{
		field: "promptCacheRetention",
		names: ["prompt_cache_retention"],
		value: { promptCacheRetention: "extended" },
	},
];

/** Instances still to be fixed; each entry goes when its fix lands. */
const KNOWN_GAPS = new Set<string>([]);

function declaredDropped(
	parameters: Record<string, boolean | { mode?: string }> | undefined,
	names: readonly string[],
): boolean {
	return names.some((name) => {
		const entry = parameters?.[name];
		if (entry === undefined) {
			return false;
		}
		if (typeof entry === "boolean") {
			return !entry;
		}
		return entry.mode === "unsupported" || entry.mode === "ignored";
	});
}

type Outcome = { kind: "request"; fingerprint: string } | { kind: "rejected" };

test("every canonical field reaches the upstream, is rejected, or is declared dropped", () => {
	const lost: string[] = [];
	for (const adapter of listAdapters()) {
		const { chat } = adapter;
		const transports = adapter.transports?.chat?.supported ?? [];
		const catalog = MODEL_CATALOG[adapter.key];
		if (!(chat && catalog)) {
			continue;
		}
		for (const [model, entry] of Object.entries(catalog)) {
			const text = entry.operations["text.generate"];
			if (!text) {
				continue;
			}
			const meta = resolveModelMetadata(adapter.key, model);
			const levels = meta.reasoning?.levels ?? [];
			const effort = levels.at(-1);
			for (const transport of transports as UpstreamTransport[]) {
				const declared = withAdapterParameters(
					meta,
					adapter.chatParameters?.[transport],
				).operations?.["text.generate"]?.parameters;
				const ctx: AdapterContext = {
					upstreamModel: model,
					credentials: { apiKey: "k", baseUrl: "https://upstream.test" },
					meta,
					transport,
					requestId: "coverage",
				};
				const build = (req: CanonicalChatRequest): Outcome => {
					try {
						adapter.assertChatRequestSupported?.(req, {
							upstreamModel: model,
							meta,
							transport,
						});
						const built = chat.buildRequest(req, ctx);
						return {
							kind: "request",
							fingerprint: JSON.stringify([
								built.url,
								built.headers,
								built.body,
							]),
						};
					} catch (error) {
						if (GatewayError.is(error)) {
							return { kind: "rejected" };
						}
						throw error;
					}
				};
				for (const probe of PROBES) {
					if (KNOWN_GAPS.has(`${adapter.key}:${probe.field}`)) {
						continue;
					}
					let { value } = probe;
					if (probe.field === "reasoning") {
						if (
							levels.filter((level) => level !== "none").length < 2 ||
							!effort
						) {
							continue;
						}
						value = { reasoning: { effort } };
					}
					const base = build({ ...BASE, ...probe.base });
					const probed = build({ ...BASE, ...value });
					if (
						base.kind === "request" &&
						probed.kind === "request" &&
						base.fingerprint === probed.fingerprint &&
						!declaredDropped(declared, probe.names)
					) {
						lost.push(`${adapter.key}/${model} (${transport}): ${probe.field}`);
					}
				}
			}
		}
	}
	assert.deepEqual(lost, []);
});
