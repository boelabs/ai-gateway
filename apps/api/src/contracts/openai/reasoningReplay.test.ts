import {
	responseForClient,
	withoutGatewayStateItems,
} from "./responsesRender.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("raw input drops reasoning items a stateless upstream cannot resolve", () => {
	const items = withoutGatewayStateItems([
		{ type: "reasoning", id: "rs_stored", summary: [] },
		{
			type: "reasoning",
			id: "rs_portable",
			summary: [],
			encrypted_content: "opaque",
		},
		{ role: "user", content: "hi" },
	]);
	assert.deepEqual(
		items.map((item) => (item as { id?: string }).id ?? "message"),
		["rs_portable", "message"],
	);
});

test("state carriers kept for storage are not shown to a client that did not ask", () => {
	const response = {
		output: [
			{ type: "function_call", call_id: "c" },
			{
				type: "reasoning",
				id: "rs_x",
				summary: [],
				encrypted_content: "bfrs_sealed",
			},
		],
	};
	assert.deepEqual(
		(responseForClient(response, undefined).output as unknown[]).length,
		1,
	);
	assert.equal(
		(
			responseForClient(response, ["reasoning.encrypted_content"])
				.output as unknown[]
		).length,
		2,
	);
});
