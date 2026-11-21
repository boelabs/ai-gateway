import { generateText, jsonSchema, streamText, tool } from "ai";
import { json, mockGateway, sse } from "../test-support.ts";
import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";

import {
	createProviderExecutedToolFactory,
	zodSchema,
} from "@ai-sdk/provider-utils";

const usage = {
	input_tokens: 120,
	input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
	output_tokens: 50,
	output_tokens_details: { reasoning_tokens: 30 },
	total_tokens: 170,
};

function response(output: unknown[], extra: Record<string, unknown> = {}) {
	return {
		id: "resp_1",
		object: "response",
		created_at: 1_760_000_000,
		model: "general",
		status: "completed",
		output,
		usage,
		reasoning: { effort: "medium" },
		...extra,
	};
}

const reasoningItem = {
	type: "reasoning",
	id: "rs_1",
	encrypted_content: "bfrs_1.sealed",
	summary: [{ type: "summary_text", text: "Thinking about it." }],
};

const messageItem = {
	type: "message",
	id: "msg_1",
	role: "assistant",
	status: "completed",
	content: [
		{
			type: "output_text",
			text: "Paris is the capital.",
			annotations: [
				{
					type: "url_citation",
					url: "https://example.com/paris",
					title: "Paris",
					start_index: 0,
					end_index: 5,
				},
			],
		},
	],
};

describe("Responses language model", () => {
	test("sends the AI SDK settings as the gateway's Responses request", async () => {
		const { provider, requests } = mockGateway([json(response([messageItem]))]);
		await generateText({
			model: provider("general"),
			system: "Be brief.",
			prompt: "Capital of France?",
			temperature: 0.3,
			topP: 0.9,
			maxOutputTokens: 200,
			reasoning: "high",
			providerOptions: {
				boelabsGateway: {
					reasoningSummary: "detailed",
					promptCacheKey: "tenant-1",
					serviceMode: "flex",
					metadata: { tenant: "acme" },
				},
			},
		});

		expect(requests[0]?.url).toBe("https://gateway.test/v1/responses");
		expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
		expect(requests[0]?.headers.get("user-agent")).toContain(
			"ai-sdk/boelabs-gateway/",
		);
		expect(requests[0]?.body).toEqual({
			model: "general:flex",
			input: [
				{ role: "system", content: "Be brief." },
				{
					role: "user",
					content: [{ type: "input_text", text: "Capital of France?" }],
				},
			],
			max_output_tokens: 200,
			temperature: 0.3,
			top_p: 0.9,
			reasoning: { effort: "high", summary: "detailed" },
			include: ["reasoning.encrypted_content"],
			metadata: { tenant: "acme" },
			prompt_cache_key: "tenant-1",
		});
	});

	test("maps reasoning, text, citations, usage and gateway metadata", async () => {
		const { provider } = mockGateway([
			json(response([reasoningItem, messageItem]), {
				headers: { "x-request-id": "req_abc" },
			}),
		]);
		const result = await generateText({
			model: provider("general"),
			prompt: "Capital of France?",
		});

		expect(result.text).toBe("Paris is the capital.");
		expect(result.reasoningText).toBe("Thinking about it.");
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]).toMatchObject({
			sourceType: "url",
			url: "https://example.com/paris",
			title: "Paris",
		});
		expect(result.finishReason).toBe("stop");
		expect(result.usage.inputTokens).toBe(120);
		expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(20);
		expect(result.usage.inputTokenDetails.cacheWriteTokens).toBe(10);
		expect(result.usage.inputTokenDetails.noCacheTokens).toBe(90);
		expect(result.usage.outputTokenDetails.reasoningTokens).toBe(30);
		expect(result.usage.outputTokenDetails.textTokens).toBe(20);
		expect(result.providerMetadata?.boelabsGateway).toMatchObject({
			responseId: "resp_1",
			requestId: "req_abc",
			reasoningEffort: "medium",
		});
	});

	test("replays reasoning, messages and tool calls with their gateway state", async () => {
		const { provider, requests } = mockGateway([
			json(
				response([
					reasoningItem,
					{
						type: "function_call",
						id: "fc_1",
						call_id: "call_1__thought__c2ln",
						name: "weather",
						arguments: '{"city":"Paris"}',
					},
				]),
			),
			json(response([messageItem])),
		]);
		const result = await generateText({
			model: provider("general"),
			prompt: "Weather in Paris?",
			tools: {
				weather: tool({
					inputSchema: jsonSchema<{ city: string }>({
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					}),
					execute: async ({ city }) => `Sunny in ${city}`,
				}),
			},
			stopWhen: ({ steps }) => steps.length >= 2,
		});

		expect(result.text).toBe("Paris is the capital.");
		expect(requests[0]?.body).toMatchObject({
			tools: [
				{
					type: "function",
					name: "weather",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			],
			tool_choice: "auto",
		});
		const { input } = requests[1]!.body as { input: unknown[] };
		expect(input.slice(1)).toEqual([
			{
				type: "reasoning",
				id: "rs_1",
				encrypted_content: "bfrs_1.sealed",
				summary: [{ type: "summary_text", text: "Thinking about it." }],
			},
			{
				type: "function_call",
				id: "fc_1",
				call_id: "call_1__thought__c2ln",
				name: "weather",
				arguments: '{"city":"Paris"}',
			},
			{
				type: "function_call_output",
				call_id: "call_1__thought__c2ln",
				output: "Sunny in Paris",
			},
		]);
	});

	test("replays assistant text as a message item that keeps its id", async () => {
		const { provider, requests } = mockGateway([
			json(response([reasoningItem, messageItem])),
			json(response([messageItem])),
		]);
		const first = await generateText({
			model: provider("general"),
			prompt: "Hi",
		});
		await generateText({
			model: provider("general"),
			messages: [
				{ role: "user", content: "Hi" },
				...first.response.messages,
				{ role: "user", content: "And Spain?" },
			],
		});
		const { input } = requests[1]!.body as { input: unknown[] };
		expect(input[2]).toEqual({
			type: "message",
			role: "assistant",
			id: "msg_1",
			content: [
				{ type: "output_text", text: "Paris is the capital.", annotations: [] },
			],
		});
	});

	test("sends only function tools and warns about provider-executed ones", async () => {
		const webSearch = createProviderExecutedToolFactory<
			Record<string, never>,
			unknown,
			Record<string, never>
		>({
			id: "openai.web_search",
			inputSchema: zodSchema(z.object({})),
			outputSchema: zodSchema(z.unknown()),
		});
		const { provider, requests } = mockGateway([json(response([messageItem]))]);
		const result = await generateText({
			model: provider("general"),
			prompt: "Weather?",
			tools: { search: webSearch({}) },
		});
		expect(requests[0]!.body).not.toHaveProperty("tools");
		expect(result.warnings).toContainEqual({
			type: "unsupported",
			feature: "provider tool openai.web_search",
			details: "Only function tools are sent to the gateway.",
		});
	});

	test("sends structured output as text.format", async () => {
		const { provider, requests } = mockGateway([
			json(
				response([
					{
						...messageItem,
						content: [
							{
								type: "output_text",
								text: '{"city":"Paris"}',
								annotations: [],
							},
						],
					},
				]),
			),
		]);
		const { Output } = await import("ai");
		const result = await generateText({
			model: provider("general"),
			prompt: "City?",
			output: Output.object({
				schema: jsonSchema<{ city: string }>({
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
					additionalProperties: false,
				}),
			}),
			providerOptions: { boelabsGateway: { strictJsonSchema: true } },
		});
		expect(result.output).toEqual({ city: "Paris" });
		expect((requests[0]!.body as { text: unknown }).text).toEqual({
			format: {
				type: "json_schema",
				name: "response",
				schema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
					additionalProperties: false,
				},
				strict: true,
			},
		});
	});

	test("warns about settings the Responses API does not have", async () => {
		const { provider } = mockGateway([json(response([messageItem]))]);
		const result = await generateText({
			model: provider("general"),
			prompt: "Hi",
			seed: 7,
			stopSequences: ["END"],
		});
		expect(
			result.warnings?.map(
				(warning) => "feature" in warning && warning.feature,
			),
		).toEqual(["seed", "stopSequences"]);
	});

	test("streams reasoning, text, sources and usage", async () => {
		const { provider, requests } = mockGateway([
			sse([
				{
					type: "response.created",
					response: response([], { status: "in_progress", usage: null }),
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "reasoning", id: "rs_1", summary: [] },
				},
				{
					type: "response.reasoning_summary_part.added",
					item_id: "rs_1",
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				},
				{
					type: "response.reasoning_summary_text.delta",
					item_id: "rs_1",
					summary_index: 0,
					delta: "Think",
				},
				{
					type: "response.reasoning_text.delta",
					item_id: "rs_1",
					content_index: 0,
					delta: "Think",
				},
				{
					type: "response.reasoning_summary_text.delta",
					item_id: "rs_1",
					summary_index: 0,
					delta: "ing.",
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						...reasoningItem,
						summary: [{ type: "summary_text", text: "Thinking." }],
					},
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						content: [],
					},
				},
				{
					type: "response.output_text.delta",
					item_id: "msg_1",
					output_index: 1,
					content_index: 0,
					delta: "Paris ",
				},
				{
					type: "response.output_text.delta",
					item_id: "msg_1",
					output_index: 1,
					content_index: 0,
					delta: "is the capital.",
				},
				{
					type: "response.output_text.annotation.added",
					item_id: "msg_1",
					annotation: messageItem.content[0]?.annotations[0],
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: messageItem,
				},
				{
					type: "response.completed",
					response: response([reasoningItem, messageItem]),
				},
			]),
		]);
		const result = streamText({ model: provider("general"), prompt: "Hi" });

		expect(await result.text).toBe("Paris is the capital.");
		expect(await result.reasoningText).toBe("Thinking.");
		expect(await result.sources).toHaveLength(1);
		expect(await result.finishReason).toBe("stop");
		expect((await result.usage).outputTokens).toBe(50);
		expect((await result.providerMetadata)?.boelabsGateway).toMatchObject({
			responseId: "resp_1",
			requestId: "req_456",
		});
		const reasoning = (await result.response).messages[0]?.content;
		expect(Array.isArray(reasoning) && reasoning[0]).toMatchObject({
			type: "reasoning",
			providerOptions: {
				boelabsGateway: {
					itemId: "rs_1",
					reasoningEncryptedContent: "bfrs_1.sealed",
				},
			},
		});
		expect((requests[0]!.body as { stream: boolean }).stream).toBe(true);
	});

	test("streams function calls", async () => {
		const { provider } = mockGateway([
			sse([
				{
					type: "response.created",
					response: response([], { status: "in_progress" }),
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "weather",
						arguments: "",
					},
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '{"city":',
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_1",
					output_index: 0,
					delta: '"Paris"}',
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: "weather",
						arguments: '{"city":"Paris"}',
					},
				},
				{ type: "response.completed", response: response([]) },
			]),
		]);
		const result = streamText({
			model: provider("general"),
			prompt: "Weather?",
			tools: {
				weather: tool({
					inputSchema: jsonSchema<{ city: string }>({
						type: "object",
						properties: { city: { type: "string" } },
					}),
				}),
			},
		});
		const calls = await result.toolCalls;
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toEqual({ city: "Paris" });
		expect(await result.finishReason).toBe("tool-calls");
	});

	test("reports a failed response as an error", async () => {
		const { provider } = mockGateway([
			sse([
				{
					type: "response.created",
					response: response([], { status: "in_progress" }),
				},
				{
					type: "response.failed",
					response: response([], {
						status: "failed",
						error: { code: "server_error", message: "Upstream failed" },
					}),
				},
			]),
		]);
		const errors: unknown[] = [];
		const result = streamText({
			model: provider("general"),
			prompt: "Hi",
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		await result.consumeStream();
		expect(await result.finishReason).toBe("error");
		expect(errors).toHaveLength(1);
	});

	test("surfaces gateway errors with their message", async () => {
		const { provider } = mockGateway([
			json(
				{
					error: {
						type: "invalid_request_error",
						code: "unsupported_service_mode",
						param: "model",
						message:
							"The model `general` does not support the `fast` service mode.",
					},
				},
				{ status: 400 },
			),
		]);
		await expect(
			generateText({ model: provider("general"), prompt: "Hi", maxRetries: 0 }),
		).rejects.toThrow("does not support the `fast` service mode");
	});
});
