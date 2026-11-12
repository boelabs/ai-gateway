import type { CanonicalChatRequest } from "#core/canonical.ts";
import { jsonBody, must } from "#test-support/adapters.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { vercelAdapter } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const ctx: AdapterContext = {
	upstreamModel: "anthropic/claude-sonnet-4.5",
	credentials: { apiKey: "k" },
	meta: {
		capabilities: {
			tools: true,
			vision: true,
			reasoning: false,
			structuredOutputs: false,
		},
	},
	transport: "chat_completions",
	requestId: "t",
};

test("reasoning_details go back on the assistant message they came with", () => {
	const details = [{ type: "reasoning.text", text: "second", signature: "s2" }];
	const req: CanonicalChatRequest = {
		callType: "chat",
		model: "m",
		stream: false,
		messages: [
			{ role: "user", content: "look" },
			{
				role: "assistant",
				content: null,
				toolCalls: [{ id: "c1", name: "shot", arguments: "{}" }],
			},
			{
				role: "tool",
				toolCallId: "c1",
				content: [{ type: "image", url: "data:image/png;base64,AAAA" }],
			},
			{
				role: "assistant",
				content: "Done.",
				providerFields: { vercel: { reasoning_details: details } },
			},
		],
	};
	const body = jsonBody(must(vercelAdapter, "chat").buildRequest(req, ctx));
	const withDetails = (body.messages as Record<string, unknown>[]).filter(
		(message) => message.reasoning_details !== undefined,
	);
	assert.equal(withDetails.length, 1);
	assert.equal(withDetails[0]?.role, "assistant");
	assert.equal(withDetails[0]?.content, "Done.");
	assert.deepEqual(withDetails[0]?.reasoning_details, details);
});
