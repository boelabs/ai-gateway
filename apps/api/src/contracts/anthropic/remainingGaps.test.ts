import type { CanonicalChatStreamChunk } from "#core/canonical.ts";
import { estimateMessagesInputTokens } from "./messagesTokenCount.ts";
import { anthropicAdapter } from "#adapters/anthropic/index.ts";
import { jsonBody, must } from "#test-support/adapters.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { messagesRequestSchema } from "./messages.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canonicalChunksToMessagesEvents,
	messagesRequestToCanonical,
} from "./messagesRender.ts";

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

function canonical(body: Record<string, unknown>) {
	return messagesRequestToCanonical(
		messagesRequestSchema.parse({
			model: "claude",
			max_tokens: 64,
			messages: [{ role: "user", content: "hi" }],
			...body,
		}),
	);
}

async function events(chunks: CanonicalChatStreamChunk[]) {
	async function* source() {
		yield* chunks;
	}
	const out: Record<string, unknown>[] = [];
	for await (const event of canonicalChunksToMessagesEvents(source(), {
		publicModel: "claude",
	})) {
		out.push(JSON.parse(event.data) as Record<string, unknown>);
	}
	return out;
}

function chunk(
	delta: CanonicalChatStreamChunk["choices"][number]["delta"],
	extra: Partial<CanonicalChatStreamChunk> = {},
): CanonicalChatStreamChunk {
	return {
		id: "m",
		created: 0,
		model: "claude",
		choices: [{ index: 0, delta, finishReason: null }],
		...extra,
	};
}

test("user blocks the canonical form cannot hold reach Anthropic as written", () => {
	const blocks = [
		{
			type: "document",
			source: {
				type: "text",
				media_type: "text/plain",
				data: "Grass is green.",
			},
			title: "Facts",
			citations: { enabled: true },
		},
		{ type: "image", source: { type: "file", file_id: "file_1" } },
		{
			type: "search_result",
			source: "https://example.com",
			title: "Result",
			content: [{ type: "text", text: "Sky is blue." }],
		},
		{ type: "text", text: "What colour is grass?" },
	];
	const req = canonical({ messages: [{ role: "user", content: blocks }] });
	assert.equal(req.requiresNativeWire, true);
	const body = jsonBody(must(anthropicAdapter, "chat").buildRequest(req, ctx));
	assert.deepEqual(body.messages[0].content, blocks);
});

test("Claude 4 models with extended thinking declare a budget reasoning spec", () => {
	for (const model of [
		"claude-opus-4-5",
		"claude-haiku-4-5",
		"claude-opus-4-1",
		"claude-opus-4",
		"claude-sonnet-4",
	]) {
		const meta = resolveModelMetadata("anthropic", model);
		assert.equal(meta.reasoning?.kind, "anthropic_budget", model);
	}
});

test("message_start carries the input usage Anthropic reported up front", async () => {
	const out = await events([
		chunk(
			{ role: "assistant" },
			{
				initialUsage: {
					promptTokens: 42,
					completionTokens: 0,
					totalTokens: 42,
				},
			},
		),
		chunk({ content: "hi" }),
	]);
	const start = out.find((event) => event.type === "message_start");
	assert.equal(
		(start?.message as { usage: { input_tokens: number } } | undefined)?.usage
			.input_tokens,
		42,
	);
});

test("a tool_use block stops before the next block starts", async () => {
	const out = await events([
		chunk({ toolCalls: [{ index: 0, id: "t1", name: "a", arguments: "{}" }] }),
		chunk({ toolCalls: [{ index: 1, id: "t2", name: "b", arguments: "{}" }] }),
	]);
	const lifecycle = out
		.filter((event) => String(event.type).startsWith("content_block_s"))
		.map((event) => `${String(event.type)}:${String(event.index)}`);
	assert.deepEqual(lifecycle, [
		"content_block_start:0",
		"content_block_stop:0",
		"content_block_start:1",
		"content_block_stop:1",
	]);
});

test("consecutive signed thinking blocks stay separate", async () => {
	const signed = (signature: string) => ({
		providerFields: {
			anthropic: {
				thinking_blocks: [{ type: "thinking", thinking: "", signature }],
			},
		},
	});
	const out = await events([
		chunk({ reasoning: "first" }),
		chunk(signed("sig-1")),
		chunk({ reasoning: "second" }),
		chunk(signed("sig-2")),
	]);
	const starts = out.filter((event) => event.type === "content_block_start");
	assert.equal(starts.length, 2);
});

test("count_tokens estimates inline images and PDFs by what they render to", () => {
	const image = Buffer.alloc(300_000).toString("base64");
	const pdf = Buffer.from(
		"%PDF-1.4 /Type /Pages /Type /Page /Type /Page",
		"latin1",
	).toString("base64");
	const tokens = estimateMessagesInputTokens({
		model: "claude",
		messages: [
			{
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: image },
					},
					{
						type: "document",
						source: {
							type: "base64",
							media_type: "application/pdf",
							data: pdf,
						},
					},
				],
			},
		],
	});
	// One image and two PDF pages, plus the JSON around them: far below 400,000 base64 bytes / 4.
	assert.ok(tokens > 1600 + 2 * 4600 && tokens < 12_000, String(tokens));
});

test("the native count body drops gateway state carriers", () => {
	const built = (
		anthropicAdapter.messageTokenCount as NonNullable<
			typeof anthropicAdapter.messageTokenCount
		>
	).buildRequest(
		{
			canonical: canonical({}),
			rawBody: {
				model: "claude",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "text", text: "hi" },
							{ type: "redacted_thinking", data: "bfrs_sealed" },
						],
					},
				],
			},
		},
		ctx,
	);
	assert.deepEqual(jsonBody(built).messages[0].content, [
		{ type: "text", text: "hi" },
	]);
});

test("custom tool fields with no function form keep the definitions native", () => {
	const tools = [
		{
			name: "lookup",
			input_schema: { type: "object" },
			input_examples: [{ q: "x" }],
			defer_loading: true,
		},
	];
	const req = canonical({ tools });
	assert.equal(req.requiresNativeWire, true);
	const body = jsonBody(must(anthropicAdapter, "chat").buildRequest(req, ctx));
	assert.deepEqual(body.tools, tools);
});
