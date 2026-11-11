import type { CanonicalChatStreamChunk } from "#core/canonical.ts";
import { responsesRequestSchema } from "./responses.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	responsesEventsToCanonicalChunks,
	parseResponsesResponse,
} from "./responsesTransport.ts";

import {
	canonicalChunksToResponsesEvents,
	canonicalToResponsesResponse,
} from "./responsesRender.ts";

import { toOpenAIChatChunk, toOpenAIChatResponse } from "./chat.ts";
import { parseOpenAIChatResponse } from "./chatTransport.ts";

const citation = {
	type: "url_citation",
	url: "https://example.com",
	title: "Example",
	start_index: 0,
	end_index: 5,
};
const token = { token: "Hello", logprob: -0.1, bytes: [72], top_logprobs: [] };

test("Responses annotations and logprobs reach Chat clients in Chat's shape", () => {
	const resp = parseResponsesResponse({
		id: "resp_1",
		model: "gpt",
		status: "completed",
		output: [
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: "Hello",
						annotations: [citation],
						logprobs: [token],
					},
				],
			},
		],
	});
	const chat = toOpenAIChatResponse(resp, "public") as {
		choices: { message: { annotations: unknown[] }; logprobs: unknown }[];
	};
	assert.deepEqual(chat.choices[0]?.message.annotations, [
		{
			type: "url_citation",
			url_citation: {
				url: "https://example.com",
				title: "Example",
				start_index: 0,
				end_index: 5,
			},
		},
	]);
	assert.deepEqual(chat.choices[0]?.logprobs, {
		content: [token],
		refusal: null,
	});
	// And back to Responses clients unchanged.
	const back = canonicalToResponsesResponse(resp, {
		req: responsesRequestSchema.parse({ model: "m", input: "hi" }),
		publicModel: "public",
		reasoningEffort: null,
	}) as { output: { content: Record<string, unknown>[] }[] };
	assert.deepEqual(back.output[0]?.content[0]?.annotations, [citation]);
	assert.deepEqual(back.output[0]?.content[0]?.logprobs, [token]);
});

test("streamed annotations, logprobs and phase cross to the Responses wire", async () => {
	async function* canonical() {
		const chunk = (
			chunkDelta: CanonicalChatStreamChunk["choices"][number]["delta"],
			logprobs?: unknown,
		): CanonicalChatStreamChunk => ({
			id: "r",
			created: 0,
			model: "m",
			choices: [
				{
					index: 0,
					delta: chunkDelta,
					finishReason: null,
					...(logprobs === undefined ? {} : { logprobs }),
				},
			],
		});
		yield chunk(
			{ phase: "final_answer", content: "Hello" },
			{ content: [token] },
		);
		yield chunk({
			annotations: [
				{
					type: "url_citation",
					url_citation: {
						url: "https://example.com",
						title: "Example",
						start_index: 0,
						end_index: 5,
					},
				},
			],
		});
	}
	const events: Record<string, unknown>[] = [];
	for await (const event of canonicalChunksToResponsesEvents(canonical(), {
		req: responsesRequestSchema.parse({
			model: "m",
			input: "hi",
			stream: true,
		}),
		publicModel: "public",
		reasoningEffort: null,
	})) {
		events.push(JSON.parse(event.data) as Record<string, unknown>);
	}
	const added = events.find(
		(e) => e.type === "response.output_text.annotation.added",
	);
	assert.deepEqual(added?.annotation, citation);
	const delta = events.find((e) => e.type === "response.output_text.delta");
	assert.deepEqual(delta?.logprobs, [token]);
	const done = events.find(
		(e) =>
			e.type === "response.output_item.done" &&
			(e.item as { type?: string }).type === "message",
	);
	assert.equal(
		(done?.item as { phase?: string } | undefined)?.phase,
		"final_answer",
	);
});

test("a tool-call-only Responses stream opens with the assistant role", async () => {
	async function* upstream() {
		yield {
			event: "response.output_item.added",
			data: JSON.stringify({
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", call_id: "c", name: "f", arguments: "" },
			}),
		};
	}
	const chunks: CanonicalChatStreamChunk[] = [];
	for await (const chunk of responsesEventsToCanonicalChunks(upstream())) {
		chunks.push(chunk);
	}
	assert.equal(chunks[0]?.choices[0]?.delta.role, "assistant");
});

test("Chat renders the served tier and the system fingerprint", () => {
	const resp = parseOpenAIChatResponse({
		id: "c",
		model: "gpt",
		system_fingerprint: "fp_1",
		service_tier: "flex",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content: "hi" },
				finish_reason: "stop",
			},
		],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
	const chat = toOpenAIChatResponse(resp, "public") as Record<string, unknown>;
	assert.equal(chat.system_fingerprint, "fp_1");
	assert.equal(chat.service_tier, "flex");
	const chunk = toOpenAIChatChunk(
		{
			id: "c",
			created: 0,
			model: "m",
			systemFingerprint: "fp_1",
			choices: [],
		},
		"public",
	) as Record<string, unknown>;
	assert.equal(chunk.system_fingerprint, "fp_1");
});
