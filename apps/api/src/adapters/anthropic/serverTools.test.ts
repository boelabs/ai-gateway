import { messagesRequestSchema } from "#contracts/anthropic/messages.ts";
import { jsonBody, must, streamOf } from "#test-support/adapters.ts";
import type { CanonicalChatStreamChunk } from "#core/canonical.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { anthropicAdapter } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	anthropicContentBlocksFromProviderFields,
	anthropicStreamBlockFromProviderFields,
	anthropicStopReasonFromProviderFields,
} from "#core/providerSpecificFields.ts";

import {
	canonicalChunksToMessagesEvents,
	canonicalToMessagesResponse,
	messagesRequestToCanonical,
} from "#contracts/anthropic/messagesRender.ts";

const ctx: AdapterContext = {
	upstreamModel: "claude-sonnet-4-5",
	credentials: { apiKey: "sk-ant-test" },
	meta: {
		capabilities: {
			tools: true,
			vision: true,
			reasoning: false,
			structuredOutputs: true,
		},
	},
	transport: "messages",
	requestId: "t",
};

const SERVER_CALL = {
	type: "server_tool_use",
	id: "srvtoolu_1",
	name: "web_search",
	input: { query: "claude shannon" },
};
const SEARCH_RESULT = {
	type: "web_search_tool_result",
	tool_use_id: "srvtoolu_1",
	content: [
		{
			type: "web_search_result",
			url: "https://en.wikipedia.org/wiki/Claude_Shannon",
			title: "Claude Shannon",
			encrypted_content: "EqgfCioIARgB",
			page_age: "April 30, 2025",
		},
	],
};
const CITED_TEXT = {
	type: "text",
	text: "Born in 1916.",
	citations: [
		{
			type: "web_search_result_location",
			url: "https://en.wikipedia.org/wiki/Claude_Shannon",
			title: "Claude Shannon",
			encrypted_index: "Eo8B",
			cited_text: "Claude Elwood Shannon (April 30, 1916",
		},
	],
};

function sse(events: object[]): string {
	return events
		.map(
			(event) =>
				`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
}

const STREAM = sse([
	{
		type: "message_start",
		message: {
			id: "msg_1",
			model: "claude-sonnet-4-5",
			usage: { input_tokens: 10 },
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "Searching. " },
	},
	{ type: "content_block_stop", index: 0 },
	{
		type: "content_block_start",
		index: 1,
		content_block: {
			type: "server_tool_use",
			id: "srvtoolu_1",
			name: "web_search",
		},
	},
	{
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"query":"claude' },
	},
	{
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: ' shannon"}' },
	},
	{ type: "content_block_stop", index: 1 },
	{ type: "content_block_start", index: 2, content_block: SEARCH_RESULT },
	{ type: "content_block_stop", index: 2 },
	{
		type: "content_block_start",
		index: 3,
		content_block: { type: "text", text: "" },
	},
	{
		type: "content_block_delta",
		index: 3,
		delta: { type: "text_delta", text: "Born in 1916." },
	},
	{
		type: "content_block_delta",
		index: 3,
		delta: { type: "citations_delta", citation: CITED_TEXT.citations[0] },
	},
	{ type: "content_block_stop", index: 3 },
	{
		type: "message_delta",
		delta: { stop_reason: "pause_turn" },
		usage: { output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
	},
	{ type: "message_stop" },
]);

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = [];
	for await (const item of items) {
		out.push(item);
	}
	return out;
}

async function streamedChunks(): Promise<CanonicalChatStreamChunk[]> {
	return collect(
		must(anthropicAdapter, "chat").parseStream(streamOf(STREAM), ctx),
	);
}

test("a streamed server-tool input is not a client tool call", async () => {
	const chunks = await streamedChunks();
	assert.equal(
		chunks.some((chunk) =>
			chunk.choices.some((choice) => choice.delta.toolCalls),
		),
		false,
	);
});

test("server-tool blocks stream whole in place, and the turn keeps its native content", async () => {
	const chunks = await streamedChunks();
	const streamed = chunks
		.map((chunk) =>
			anthropicStreamBlockFromProviderFields(
				chunk.choices[0]?.delta.providerFields,
			),
		)
		.filter((block) => block !== undefined);
	assert.deepEqual(streamed, [SERVER_CALL, SEARCH_RESULT]);
	const native = chunks
		.map((chunk) =>
			anthropicContentBlocksFromProviderFields(
				chunk.choices[0]?.delta.providerFields,
			),
		)
		.find((blocks) => blocks !== undefined);
	assert.deepEqual(native, [
		{ type: "text", text: "Searching. " },
		SERVER_CALL,
		SEARCH_RESULT,
		CITED_TEXT,
	]);
	const terminal = chunks.at(-1);
	assert.equal(terminal?.choices[0]?.finishReason, "stop");
	assert.equal(
		anthropicStopReasonFromProviderFields(
			terminal?.choices[0]?.delta.providerFields,
		),
		"pause_turn",
	);
	assert.deepEqual(terminal?.usage?.serverToolCalls, { web_search: 1 });
});

test("a JSON response keeps server-tool content, its stop reason and its counter", () => {
	const response = must(anthropicAdapter, "chat").parseResponse(
		{
			id: "msg_1",
			model: "claude-sonnet-4-5",
			content: [SERVER_CALL, SEARCH_RESULT, CITED_TEXT],
			stop_reason: "pause_turn",
			usage: {
				input_tokens: 10,
				output_tokens: 5,
				server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
			},
		},
		ctx,
	);
	const [choice] = response.choices;
	assert.deepEqual(response.usage.serverToolCalls, {
		web_search: 1,
		web_fetch: 2,
	});
	const rendered = canonicalToMessagesResponse(response, {
		publicModel: "claude",
	});
	assert.deepEqual(rendered.content, [SERVER_CALL, SEARCH_RESULT, CITED_TEXT]);
	assert.equal(rendered.stop_reason, "pause_turn");
	assert.deepEqual(
		(rendered.usage as Record<string, unknown>).server_tool_use,
		{
			web_search_requests: 1,
			web_fetch_requests: 2,
		},
	);
	assert.equal(choice?.message.content, "Born in 1916.");
});

test("the Messages stream renders server-tool blocks where they streamed", async () => {
	async function* chunks() {
		yield* await streamedChunks();
	}
	const events = await collect(
		canonicalChunksToMessagesEvents(chunks(), { publicModel: "claude" }),
	);
	const parsed = events.map(
		(event) => JSON.parse(event.data) as Record<string, unknown>,
	);
	const starts = parsed
		.filter((event) => event.type === "content_block_start")
		.map((event) => (event.content_block as { type: string }).type);
	assert.deepEqual(starts, [
		"text",
		"server_tool_use",
		"web_search_tool_result",
		"text",
	]);
	const serverStart = parsed.find(
		(event) =>
			event.type === "content_block_start" &&
			(event.content_block as { type: string }).type === "server_tool_use",
	);
	assert.deepEqual(
		(serverStart?.content_block as { input: unknown } | undefined)?.input,
		{},
	);
	const inputDelta = parsed.find(
		(event) =>
			event.type === "content_block_delta" &&
			event.index === serverStart?.index &&
			(event.delta as { type: string }).type === "input_json_delta",
	);
	assert.deepEqual(
		JSON.parse(
			(inputDelta?.delta as { partial_json: string } | undefined)
				?.partial_json ?? "null",
		),
		SERVER_CALL.input,
	);
	const messageDelta = parsed.find((event) => event.type === "message_delta");
	assert.equal(
		(messageDelta?.delta as { stop_reason: string } | undefined)?.stop_reason,
		"pause_turn",
	);
});

test("a replayed server-tool turn reaches Anthropic unchanged", () => {
	const turn = [
		{ type: "text", text: "Searching. " },
		SERVER_CALL,
		SEARCH_RESULT,
	];
	const canonical = messagesRequestToCanonical(
		messagesRequestSchema.parse({
			model: "claude",
			max_tokens: 50,
			tools: [{ type: "web_search_20250305", name: "web_search" }],
			messages: [
				{ role: "user", content: "When was Claude Shannon born?" },
				{ role: "assistant", content: turn },
			],
		}),
	);
	const body = jsonBody(
		must(anthropicAdapter, "chat").buildRequest(canonical, ctx),
	);
	assert.deepEqual(body.messages[1].content, turn);
});

test("the stream's opening chunk carries the input usage of message_start", async () => {
	const [first] = await streamedChunks();
	assert.equal(first?.initialUsage?.promptTokens, 10);
});
