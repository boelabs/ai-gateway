import type { CanonicalChatStreamChunk } from "#core/canonical.ts";
import { responsesEventsToCanonicalChunks } from "./responsesTransport.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function event(type: string, data: Record<string, unknown>) {
	return { event: type, data: JSON.stringify({ type, ...data }) };
}

test("Chat tool-call indexes count tool calls, not Responses output items", async () => {
	async function* events() {
		yield event("response.created", { response: { id: "resp_1", model: "m" } });
		yield event("response.output_item.added", {
			output_index: 0,
			item: { type: "reasoning", id: "rs_1", summary: [] },
		});
		yield event("response.output_item.added", {
			output_index: 1,
			item: {
				type: "function_call",
				call_id: "call_a",
				name: "a",
				arguments: "",
			},
		});
		yield event("response.function_call_arguments.delta", {
			output_index: 1,
			delta: "{}",
		});
		yield event("response.output_item.added", {
			output_index: 2,
			item: {
				type: "function_call",
				call_id: "call_b",
				name: "b",
				arguments: "",
			},
		});
		yield event("response.function_call_arguments.delta", {
			output_index: 2,
			delta: "{}",
		});
	}
	const indexes: number[] = [];
	for await (const chunk of responsesEventsToCanonicalChunks(
		events(),
	) as AsyncIterable<CanonicalChatStreamChunk>) {
		for (const call of chunk.choices[0]?.delta.toolCalls ?? []) {
			indexes.push(call.index);
		}
	}
	assert.deepEqual(indexes, [0, 0, 1, 1]);
});
