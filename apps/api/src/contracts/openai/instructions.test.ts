import type { CanonicalChatRequest } from "#core/canonical.ts";
import { buildResponsesRequestBody } from "./responsesTransport.ts";
import { responsesRequestToCanonical } from "./responsesRender.ts";
import { responsesRequestSchema } from "./responses.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("only the leading system block becomes instructions; later ones stay in place", () => {
	const req: CanonicalChatRequest = {
		callType: "chat",
		model: "m",
		stream: false,
		messages: [
			{ role: "system", content: "Be brief." },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "developer", content: "Now answer in French." },
			{ role: "user", content: "again" },
		],
	};
	const body = buildResponsesRequestBody(req, "gpt") as {
		instructions?: string;
		input: { role?: string }[];
	};
	assert.equal(body.instructions, "Be brief.");
	assert.deepEqual(
		body.input.map((item) => item.role),
		["user", "assistant", "developer", "user"],
	);
});

test("raw input is not duplicated into instructions", () => {
	const canonical = responsesRequestToCanonical(
		responsesRequestSchema.parse({
			model: "m",
			instructions: "Top-level rules.",
			input: [
				{ role: "developer", content: "Inline rules." },
				{ role: "user", content: "hi" },
				// An item the canonical form cannot hold, so the raw items are sent as they are.
				{ type: "web_search_call", id: "ws_1", status: "completed" },
			],
		}),
	);
	assert.ok(canonical.responsesTransport?.rawInput);
	const body = buildResponsesRequestBody(canonical, "gpt") as {
		instructions?: string;
	};
	assert.equal(body.instructions, "Top-level rules.");
});
