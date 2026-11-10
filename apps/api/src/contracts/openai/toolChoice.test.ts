import { buildResponsesRequestBody } from "./responsesTransport.ts";
import { responsesRequestToCanonical } from "./responsesRender.ts";
import { responsesRequestSchema } from "./responses.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function canonical(toolChoice: unknown, tools: unknown[] = []) {
	return responsesRequestToCanonical(
		responsesRequestSchema.parse({
			model: "m",
			input: "hi",
			tools,
			tool_choice: toolChoice,
		}),
	);
}

test("choices only Responses can express reach it as written", () => {
	for (const choice of [
		{ type: "web_search_preview" },
		{ type: "mcp", server_label: "docs", name: "search" },
		{ type: "custom", name: "grammar" },
		{
			type: "allowed_tools",
			mode: "required",
			tools: [{ type: "function", name: "a" }, { type: "web_search_preview" }],
		},
	]) {
		const req = canonical(choice);
		assert.equal(req.requiresNativeWire, true, JSON.stringify(choice));
		assert.equal(req.toolChoice, undefined);
		const body = buildResponsesRequestBody(req, "gpt") as {
			tool_choice?: unknown;
		};
		assert.deepEqual(body.tool_choice, choice);
	}
});

test("function choices stay canonical", () => {
	assert.deepEqual(canonical({ type: "function", name: "a" }).toolChoice, {
		name: "a",
	});
	assert.deepEqual(
		canonical({
			type: "allowed_tools",
			mode: "auto",
			tools: [{ type: "function", name: "a" }],
		}).toolChoice,
		{ allowedTools: ["a"], mode: "auto" },
	);
});

test("an unknown string tool choice is rejected instead of becoming auto", () => {
	assert.throws(
		() => canonical("sometimes"),
		(error) => GatewayError.is(error) && error.param === "tool_choice",
	);
});
