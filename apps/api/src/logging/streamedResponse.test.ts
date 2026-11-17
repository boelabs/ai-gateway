import { StreamedResponseCapture } from "./streamedResponse.ts";
import { expect, test } from "bun:test";

const chunk = (
	delta: Record<string, unknown>,
	finishReason: "stop" | "tool_calls" | null = null,
) => ({
	id: "chatcmpl-1",
	created: 1,
	model: "gpt-test",
	choices: [{ index: 0, delta, finishReason }],
});

test("StreamedResponseCapture: rebuilds content, reasoning and tool calls", () => {
	const capture = new StreamedResponseCapture();
	capture.add(chunk({ role: "assistant", reasoning: "Think" }));
	capture.add(chunk({ reasoning: "ing", content: "Hel" }));
	capture.add(chunk({ content: "lo" }));
	capture.add(
		chunk({
			toolCalls: [{ index: 0, id: "call_1", name: "f", arguments: '{"a"' }],
		}),
	);
	capture.add(
		chunk({ toolCalls: [{ index: 0, arguments: ":1}" }] }, "tool_calls"),
	);

	expect(capture.toLog()).toEqual({
		streamed: true,
		id: "chatcmpl-1",
		model: "gpt-test",
		choices: [
			{
				index: 0,
				finish_reason: "tool_calls",
				message: {
					role: "assistant",
					content: "Hello",
					reasoning: "Thinking",
					tool_calls: [{ id: "call_1", name: "f", arguments: '{"a":1}' }],
				},
			},
		],
	});
});

test("StreamedResponseCapture: a stream with no chunks is still marked as streamed", () => {
	expect(new StreamedResponseCapture().toLog()).toEqual({
		streamed: true,
		id: null,
		model: null,
		choices: [],
	});
});
