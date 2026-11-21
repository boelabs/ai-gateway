import { generateText, jsonSchema, streamText, tool } from "ai";
import { json, mockGateway, sse } from "../test-support.ts";
import { describe, expect, test } from "bun:test";

const fields = {
	openai: {
		reasoning: [{ id: "rs_1", encrypted_content: "enc", summary: [] }],
	},
};

function completion(message: Record<string, unknown>, finish = "stop") {
	return {
		id: "chatcmpl-1",
		object: "chat.completion",
		created: 1_760_000_000,
		model: "general",
		choices: [
			{
				index: 0,
				finish_reason: finish,
				message: { role: "assistant", ...message },
			},
		],
		usage: {
			prompt_tokens: 40,
			completion_tokens: 12,
			total_tokens: 52,
			prompt_tokens_details: { cached_tokens: 8 },
			completion_tokens_details: { reasoning_tokens: 5 },
		},
	};
}

describe("Chat Completions language model", () => {
	test("is the text API when configured, and sends Chat-only settings", async () => {
		const { provider, requests } = mockGateway(
			[json(completion({ content: "Hi" }))],
			{ textApi: "chat" },
		);
		await generateText({
			model: provider("general"),
			prompt: "Hello",
			seed: 7,
			topK: 40,
			stopSequences: ["END"],
			reasoning: "low",
			providerOptions: {
				boelabsGateway: { cache: { ttl: 600 }, routingMetadata: true },
			},
		});
		expect(requests[0]?.url).toBe("https://gateway.test/v1/chat/completions");
		expect(requests[0]?.headers.get("x-unified-cache")).toBe("true");
		expect(requests[0]?.headers.get("x-unified-cache-ttl")).toBe("600");
		expect(requests[0]?.headers.get("x-unified-routing-metadata")).toBe("true");
		expect(requests[0]?.body).toEqual({
			model: "general",
			messages: [{ role: "user", content: "Hello" }],
			top_k: 40,
			stop: ["END"],
			seed: 7,
			reasoning_effort: "low",
		});
	});

	test("returns reasoning, text, usage and the routing report", async () => {
		const { provider } = mockGateway([
			json({
				...completion({ content: "Hi there", reasoning: "Greeting." }),
				unified_routing: { served_model: "gpt-6", fallback_used: false },
			}),
		]);
		const result = await generateText({
			model: provider.chat("general"),
			prompt: "Hi",
		});
		expect(result.text).toBe("Hi there");
		expect(result.reasoningText).toBe("Greeting.");
		expect(result.usage.inputTokenDetails.cacheReadTokens).toBe(8);
		expect(result.usage.outputTokenDetails.reasoningTokens).toBe(5);
		expect(result.providerMetadata?.boelabsGateway).toMatchObject({
			requestId: "req_123",
			routing: { served_model: "gpt-6", fallback_used: false },
		});
	});

	test("sends provider_specific_fields back with the assistant turn", async () => {
		const { provider, requests } = mockGateway([
			json(
				completion(
					{
						content: null,
						tool_calls: [
							{
								id: "call_1__thought__c2ln",
								type: "function",
								function: { name: "weather", arguments: '{"city":"Paris"}' },
							},
						],
						provider_specific_fields: fields,
					},
					"tool_calls",
				),
			),
			json(completion({ content: "Sunny." })),
		]);
		await generateText({
			model: provider.chat("general"),
			prompt: "Weather?",
			tools: {
				weather: tool({
					inputSchema: jsonSchema<{ city: string }>({ type: "object" }),
					execute: async () => "Sunny",
				}),
			},
			stopWhen: ({ steps }) => steps.length >= 2,
		});
		const { messages } = requests[1]!.body as { messages: unknown[] };
		expect(messages[1]).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call_1__thought__c2ln",
					type: "function",
					function: { name: "weather", arguments: '{"city":"Paris"}' },
				},
			],
			provider_specific_fields: fields,
		});
		expect(messages[2]).toEqual({
			role: "tool",
			tool_call_id: "call_1__thought__c2ln",
			content: "Sunny",
		});
	});

	test("streams reasoning, text, tool calls and usage", async () => {
		const chunk = (
			delta: Record<string, unknown>,
			extra: Record<string, unknown> = {},
		) => ({
			id: "chatcmpl-1",
			object: "chat.completion.chunk",
			created: 1_760_000_000,
			model: "general",
			choices: [{ index: 0, finish_reason: null, delta }],
			...extra,
		});
		const { provider, requests } = mockGateway([
			sse([
				chunk({ role: "assistant", content: "" }),
				chunk({ reasoning: "Plan." }),
				chunk({ content: "Checking " }),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "weather", arguments: '{"city"' },
						},
					],
				}),
				chunk({
					tool_calls: [{ index: 0, function: { arguments: ':"Paris"}' } }],
				}),
				chunk({ provider_specific_fields: fields }),
				{
					...chunk({}),
					choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }],
				},
				{
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
				},
			]),
		]);
		const result = streamText({
			model: provider.chat("general"),
			prompt: "Weather?",
			tools: {
				weather: tool({
					inputSchema: jsonSchema<{ city: string }>({ type: "object" }),
				}),
			},
		});
		expect(await result.text).toBe("Checking ");
		expect(await result.reasoningText).toBe("Plan.");
		const calls = await result.toolCalls;
		expect(calls[0]?.input).toEqual({ city: "Paris" });
		expect(await result.finishReason).toBe("tool-calls");
		expect((await result.usage).totalTokens).toBe(16);
		expect(requests[0]?.body).toMatchObject({
			stream: true,
			stream_options: { include_usage: true },
		});
		const [assistant] = (await result.response).messages;
		const parts = Array.isArray(assistant?.content) ? assistant.content : [];
		const call = parts.find((part) => part.type === "tool-call");
		expect(call?.providerOptions?.boelabsGateway).toEqual({
			providerSpecificFields: fields,
		});
	});
});
