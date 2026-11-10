import { anthropicAdapter } from "#adapters/anthropic/index.ts";
import { messagesRequestToCanonical } from "./messagesRender.ts";
import { jsonBody, must } from "#test-support/adapters.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { messagesRequestSchema } from "./messages.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const ctx: AdapterContext = {
	upstreamModel: "claude-sonnet-4-5",
	credentials: { apiKey: "sk-ant-test" },
	meta: {
		capabilities: {
			tools: true,
			vision: true,
			reasoning: false,
			structuredOutputs: true,
		},
	},
	transport: "messages",
	requestId: "t",
};

function canonical(body: Record<string, unknown>, betas?: string[]) {
	return messagesRequestToCanonical(
		messagesRequestSchema.parse({
			model: "claude",
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
			...body,
		}),
		betas === undefined ? {} : { betas },
	);
}

test("documented native top-level fields reach Anthropic and require its wire", () => {
	const fields = {
		container: "container_1",
		mcp_servers: [{ type: "url", url: "https://mcp.example", name: "x" }],
		context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
		inference_geo: "us",
		service_tier: "standard_only",
	};
	const req = canonical(fields);
	assert.equal(req.requiresNativeWire, true);
	const body = jsonBody(must(anthropicAdapter, "chat").buildRequest(req, ctx));
	for (const [key, value] of Object.entries(fields)) {
		assert.deepEqual(body[key], value);
	}
});

test("an unknown top-level field is rejected instead of dropped", () => {
	assert.throws(
		() => canonical({ temprature: 0.2 }),
		(error) =>
			GatewayError.is(error) &&
			error.code === "unknown_parameter" &&
			error.param === "temprature",
	);
});

test("client betas reach Anthropic beside the adapter's own", () => {
	const req = canonical({}, [
		"context-management-2025-06-27, interleaved-thinking-2025-05-14",
	]);
	const built = must(anthropicAdapter, "chat").buildRequest(req, {
		...ctx,
		upstreamModel: "claude-opus-5-fast",
	});
	const betas = String(built.headers["anthropic-beta"]).split(",");
	assert.ok(betas.includes("context-management-2025-06-27"));
	assert.ok(betas.includes("interleaved-thinking-2025-05-14"));
	assert.ok(betas.includes("fast-mode-2026-02-01"));
	assert.equal(req.requiresNativeWire, undefined);
});

test("a malformed beta name is rejected", () => {
	assert.throws(
		() => canonical({}, ["context-management\r\nx-api-key: stolen"]),
		(error) => GatewayError.is(error) && error.param === "anthropic-beta",
	);
});

test("a native field that contradicts the model's own setting is rejected", () => {
	const req = canonical({ speed: "standard" });
	assert.throws(
		() =>
			must(anthropicAdapter, "chat").buildRequest(req, {
				...ctx,
				upstreamModel: "claude-opus-5-fast",
			}),
		(error) => GatewayError.is(error) && error.param === "speed",
	);
});
