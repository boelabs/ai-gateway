import type { CanonicalChatStreamChunk } from "#core/canonical.ts";

interface CapturedToolCall {
	id?: string;
	name?: string;
	arguments: string;
	extraContent?: Record<string, unknown>;
}

interface CapturedChoice {
	index: number;
	content: string;
	reasoning: string;
	refusal: string;
	toolCalls: Map<number, CapturedToolCall>;
	annotations: Record<string, unknown>[];
	finishReason: string | null;
	stopSequence?: string | null;
}

/**
 * Rebuilds what a streamed chat answer said, chunk by chunk, so the retained sample holds the whole
 * response instead of a marker that it streamed.
 */
export class StreamedResponseCapture {
	private id: string | null = null;
	private model: string | null = null;
	private readonly choices = new Map<number, CapturedChoice>();

	add(chunk: CanonicalChatStreamChunk): void {
		this.id ??= chunk.id;
		this.model ??= chunk.model;
		for (const { index, delta, finishReason, stopSequence } of chunk.choices) {
			let choice = this.choices.get(index);
			if (!choice) {
				choice = {
					index,
					content: "",
					reasoning: "",
					refusal: "",
					toolCalls: new Map(),
					annotations: [],
					finishReason: null,
				};
				this.choices.set(index, choice);
			}
			choice.content += delta.content ?? "";
			choice.reasoning += delta.reasoning ?? "";
			choice.refusal += delta.refusal ?? "";
			if (delta.annotations) {
				choice.annotations.push(...delta.annotations);
			}
			for (const call of delta.toolCalls ?? []) {
				const captured = choice.toolCalls.get(call.index) ?? { arguments: "" };
				if (call.id) {
					captured.id = call.id;
				}
				if (call.name) {
					captured.name = call.name;
				}
				captured.arguments += call.arguments ?? "";
				if (call.extraContent) {
					captured.extraContent = call.extraContent;
				}
				choice.toolCalls.set(call.index, captured);
			}
			if (finishReason !== null) {
				choice.finishReason = finishReason;
			}
			if (stopSequence !== undefined) {
				choice.stopSequence = stopSequence;
			}
		}
	}

	toLog(): Record<string, unknown> {
		return {
			streamed: true,
			id: this.id,
			model: this.model,
			choices: [...this.choices.values()]
				.sort((a, b) => a.index - b.index)
				.map((choice) => ({
					index: choice.index,
					finish_reason: choice.finishReason,
					...(choice.stopSequence === undefined
						? {}
						: { stop_sequence: choice.stopSequence }),
					message: {
						role: "assistant",
						content: choice.content || null,
						...(choice.reasoning ? { reasoning: choice.reasoning } : {}),
						...(choice.refusal ? { refusal: choice.refusal } : {}),
						...(choice.toolCalls.size > 0
							? {
									tool_calls: [...choice.toolCalls.entries()]
										.sort(([a], [b]) => a - b)
										.map(([, call]) => call),
								}
							: {}),
						...(choice.annotations.length > 0
							? { annotations: choice.annotations }
							: {}),
					},
				})),
		};
	}
}
