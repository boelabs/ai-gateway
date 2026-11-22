import { toCanonicalChatRequest, chatRequestSchema } from "./openai/chat.ts";
import { responsesRequestToCanonical } from "./openai/responsesRender.ts";
import { anthropicAdapter } from "#adapters/anthropic/index.ts";
import { jsonBody, must } from "#test-support/adapters.ts";
import { responsesRequestSchema } from "./openai/responses.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const binding = { prefix_mismatch_behavior: "drop_block" };

const adaptiveCtx: AdapterContext = {
	upstreamModel: "claude-opus-4-8",
	credentials: { apiKey: "sk-ant-test" },
	meta: {
		maxOutputTokens: 2048,
		capabilities: {
			tools: true,
			vision: true,
			reasoning: true,
			structuredOutputs: true,
		},
		reasoning: {
			kind: "anthropic_adaptive",
			levels: ["none", "low", "medium", "high", "xhigh", "max"],
		},
	},
	transport: "messages",
	requestId: "t",
};

function chat(fields: Record<string, unknown>): CanonicalChatRequest {
	return toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "claude",
			reasoning_effort: "high",
			messages: [{ role: "user", content: "hi" }],
			...fields,
		}),
	);
}

function responses(fields: Record<string, unknown>): CanonicalChatRequest {
	return responsesRequestToCanonical(
		responsesRequestSchema.parse({
			model: "claude",
			reasoning: { effort: "high" },
			input: "hi",
			...fields,
		}),
	);
}

test("extra_body.thinking.block_binding leaves extra_body on both OpenAI-shaped wires", () => {
	for (const toCanonical of [chat, responses]) {
		const req = toCanonical({
			extra_body: { thinking: { block_binding: binding }, top_k: 40 },
		});
		assert.deepEqual(req.messagesTransport?.thinkingBlockBinding, binding);
		assert.deepEqual(req.extraBody, { top_k: 40 });
		assert.equal(req.requiresNativeWire, undefined);

		const alone = toCanonical({
			extra_body: { thinking: { block_binding: binding } },
		});
		assert.equal(alone.extraBody, undefined);
	}
});

test("a top-level thinking.block_binding on chat completions is lifted too", () => {
	const req = chat({ thinking: { block_binding: binding } });
	assert.deepEqual(req.messagesTransport?.thinkingBlockBinding, binding);
	assert.equal(req.extraBody, undefined);
});

test("extra_body.thinking.block_binding reaches Anthropic's adaptive thinking with its beta", () => {
	for (const toCanonical of [chat, responses]) {
		const built = must(anthropicAdapter, "chat").buildRequest(
			toCanonical({ extra_body: { thinking: { block_binding: binding } } }),
			adaptiveCtx,
		);
		assert.deepEqual(jsonBody(built).thinking.block_binding, binding);
		assert.equal(jsonBody(built).thinking.type, "adaptive");
		assert.equal(
			built.headers["anthropic-beta"],
			"thinking-binding-controls-2026-08-01",
		);
	}
});

test("any other extra_body.thinking stays in extra_body", () => {
	const thinking = { type: "adaptive", block_binding: binding };
	const req = chat({ extra_body: { thinking } });
	assert.deepEqual(req.extraBody, { thinking });
	assert.equal(req.messagesTransport, undefined);
});

test("an extra_body.thinking.block_binding that is not an object is rejected", () => {
	assert.throws(
		() => responses({ extra_body: { thinking: { block_binding: "drop" } } }),
		(error) =>
			GatewayError.is(error) &&
			error.param === "extra_body.thinking.block_binding",
	);
});
