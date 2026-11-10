import type { CanonicalChatStreamChunk } from "#core/canonical.ts";
import { responsesRequestSchema } from "./responses.ts";
import { buildOpenAIChatBody } from "./chatTransport.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	responsesEventsToCanonicalChunks,
	buildResponsesRequestBody,
	parseResponsesResponse,
} from "./responsesTransport.ts";

import {
	canonicalChunksToResponsesEvents,
	canonicalToResponsesResponse,
	responsesRequestToCanonical,
} from "./responsesRender.ts";

import {
	toCanonicalChatRequest,
	toOpenAIChatResponse,
	chatRequestSchema,
} from "./chat.ts";

function chat(messages: unknown[]) {
	return toCanonicalChatRequest(
		chatRequestSchema.parse({ model: "m", messages }),
	);
}

test("an assistant refusal on Chat input reaches both OpenAI transports", () => {
	for (const assistant of [
		{ role: "assistant", content: null, refusal: "I can't help with that." },
		{
			role: "assistant",
			content: [{ type: "refusal", refusal: "I can't help with that." }],
		},
	]) {
		const req = chat([{ role: "user", content: "hi" }, assistant]);
		assert.equal(req.messages[1]?.refusal, "I can't help with that.");
		const chatBody = buildOpenAIChatBody(req, "gpt") as {
			messages: Record<string, unknown>[];
		};
		assert.equal(chatBody.messages[1]?.refusal, "I can't help with that.");
		const responsesBody = buildResponsesRequestBody(req, "gpt") as {
			input: { content?: unknown }[];
		};
		assert.deepEqual(responsesBody.input[1]?.content, [
			{ type: "refusal", refusal: "I can't help with that." },
		]);
	}
});

test("a Responses refusal reaches Chat and Responses clients", () => {
	const resp = parseResponsesResponse({
		id: "resp_1",
		created_at: 1,
		model: "gpt",
		status: "completed",
		output: [
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [{ type: "refusal", refusal: "No." }],
			},
		],
	});
	assert.equal(resp.choices[0]?.message.refusal, "No.");
	const asChat = toOpenAIChatResponse(resp, "public") as {
		choices: { message: { refusal: string | null } }[];
	};
	assert.equal(asChat.choices[0]?.message.refusal, "No.");
	const asResponses = canonicalToResponsesResponse(resp, {
		req: responsesRequestSchema.parse({ model: "m", input: "hi" }),
		publicModel: "public",
		reasoningEffort: null,
	}) as { output: { content: unknown[] }[] };
	assert.deepEqual(asResponses.output[0]?.content, [
		{ type: "refusal", refusal: "No." },
	]);
});

test("streamed refusals survive the Responses transport and render as refusal events", async () => {
	async function* upstream() {
		yield {
			event: "response.refusal.delta",
			data: JSON.stringify({
				type: "response.refusal.delta",
				output_index: 0,
				content_index: 0,
				delta: "No.",
			}),
		};
	}
	const chunks: CanonicalChatStreamChunk[] = [];
	for await (const chunk of responsesEventsToCanonicalChunks(upstream())) {
		chunks.push(chunk);
	}
	assert.equal(chunks[0]?.choices[0]?.delta.refusal, "No.");
	async function* canonical() {
		yield {
			id: "r",
			created: 0,
			model: "m",
			choices: [{ index: 0, delta: { refusal: "No." }, finishReason: null }],
		} satisfies CanonicalChatStreamChunk;
	}
	const types: string[] = [];
	for await (const event of canonicalChunksToResponsesEvents(canonical(), {
		req: responsesRequestSchema.parse({
			model: "m",
			input: "hi",
			stream: true,
		}),
		publicModel: "public",
		reasoningEffort: null,
	})) {
		types.push(JSON.parse(event.data).type as string);
	}
	assert.ok(types.includes("response.refusal.delta"), types.join(","));
	assert.ok(types.includes("response.refusal.done"), types.join(","));
});

test("a refusal sent back on /v1/responses stays a refusal", () => {
	const req = responsesRequestToCanonical(
		responsesRequestSchema.parse({
			model: "m",
			input: [
				{ role: "user", content: "hi" },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "refusal", refusal: "No." }],
				},
			],
		}),
	);
	const assistant = req.messages.find(
		(message) => message.role === "assistant",
	);
	assert.equal(assistant?.refusal, "No.");
});

test("legacy function_call messages are rejected instead of dropped", () => {
	assert.throws(
		() =>
			chat([
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: null,
					function_call: { name: "f", arguments: "{}" },
				},
			]),
		(error) => GatewayError.is(error) && error.param === "messages",
	);
});
