import { chatRequestSchema, toCanonicalChatRequest } from "./chat.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function canonical(body: Record<string, unknown>) {
	return toCanonicalChatRequest(
		chatRequestSchema.parse({
			model: "m",
			messages: [{ role: "user", content: "hi" }],
			...body,
		}),
	);
}

test("top_k on Chat becomes the canonical topK", () => {
	assert.equal(canonical({ top_k: 40 }).topK, 40);
});

test("unmapped top-level fields reach the upstream through extra_body", () => {
	const req = canonical({
		repetition_penalty: 1.1,
		min_p: 0.05,
		extra_body: { guided_json: { type: "object" } },
	});
	assert.deepEqual(req.extraBody, {
		guided_json: { type: "object" },
		repetition_penalty: 1.1,
		min_p: 0.05,
	});
});

test("a field set both at the top level and in extra_body must agree", () => {
	assert.throws(
		() => canonical({ min_p: 0.05, extra_body: { min_p: 0.1 } }),
		(error) => GatewayError.is(error) && error.param === "min_p",
	);
});

test("legacy function calling is rejected instead of dropped", () => {
	for (const field of [
		{ functions: [{ name: "f", parameters: { type: "object" } }] },
		{ function_call: "auto" },
	]) {
		assert.throws(
			() => canonical(field),
			(error) =>
				GatewayError.is(error) && error.code === "unsupported_parameter",
		);
	}
});
