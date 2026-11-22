import { jsonBody, must } from "#test-support/adapters.ts";
import type { AdapterContext } from "./types.ts";
import { getAdapter } from "./registry.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	toCanonicalChatRequest,
	chatRequestSchema,
} from "#contracts/openai/chat.ts";

import "./index.ts";

const ctx: AdapterContext = {
	upstreamModel: "m",
	credentials: { apiKey: "k", baseUrl: "https://upstream.test/v1" },
	meta: {
		capabilities: {
			tools: true,
			vision: false,
			reasoning: false,
			structuredOutputs: false,
		},
	},
	transport: "chat_completions",
	requestId: "t",
};

const request = toCanonicalChatRequest(
	chatRequestSchema.parse({
		model: "m",
		messages: [
			{ role: "user", content: "find x" },
			{
				role: "assistant",
				content: null,
				reasoning_content: "I should search.",
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "search", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "found" },
		],
	}),
);

test("providers that need it get the assistant's reasoning_content back", () => {
	for (const key of ["deepseek", "moonshot", "zai", "minimax"]) {
		const adapter = getAdapter(key);
		assert.ok(adapter, key);
		const body = jsonBody(must(adapter, "chat").buildRequest(request, ctx));
		assert.equal(body.messages[1].reasoning_content, "I should search.", key);
	}
});

test("OpenAI-shaped upstreams that define no such field do not receive it", () => {
	const adapter = getAdapter("openaicompatible");
	assert.ok(adapter);
	const body = jsonBody(must(adapter, "chat").buildRequest(request, ctx));
	assert.equal(body.messages[1].reasoning_content, undefined);
});
