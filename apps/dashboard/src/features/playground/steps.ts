import type { PlaygroundMessage } from "./transport";

type MessagePart = PlaygroundMessage["parts"][number];

/**
 * The steps an answer took before and between its text. The playground sends no tools of its own,
 * so a step is reasoning, or a tool call a model made through the gateway, shown generically with
 * its input and result.
 */
export type StepKind = "reasoning" | "tool";
export type StepStatus = "running" | "done" | "error";

export type StepBlock =
	| { type: "markdown"; text: string }
	| { type: "code"; label: "input" | "output" | "error"; text: string };

export interface Step {
	/** Stable while the message streams. */
	key: string;
	kind: StepKind;
	status: StepStatus;
	/** The tool's name, for a tool step. */
	name?: string;
	blocks: StepBlock[];
}

/** An answer as it is drawn: one line above its text for every step, wherever the model took it. */
export interface Answer {
	steps: Step[];
	/** What arrived last is text: while the turn runs, the model is writing, not working. */
	endsInText: boolean;
}

function asText(value: unknown): string {
	if (value === undefined) {
		return "";
	}
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function toolStatus(part: { state?: string }): StepStatus {
	switch (part.state) {
		case "output-error":
		case "output-denied":
			return "error";
		case "output-available":
			return "done";
		default:
			return "running";
	}
}

/** The step a part shows, or null for a part that is not one. */
export function stepOf(part: MessagePart, index: number): Step | null {
	if (part.type === "reasoning") {
		return {
			key: `reasoning-${index}`,
			kind: "reasoning",
			status: part.state === "done" ? "done" : "running",
			blocks: part.text.trim() ? [{ type: "markdown", text: part.text }] : [],
		};
	}
	if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
		const tool = part as {
			type: string;
			toolCallId?: string;
			toolName?: string;
			state?: string;
			input?: unknown;
			output?: unknown;
			errorText?: string;
		};
		const blocks: StepBlock[] = [];
		const input = asText(tool.input);
		if (input) {
			blocks.push({ type: "code", label: "input", text: input });
		}
		const output = asText(tool.output);
		if (output) {
			blocks.push({ type: "code", label: "output", text: output });
		}
		if (tool.errorText) {
			blocks.push({ type: "code", label: "error", text: tool.errorText });
		}
		return {
			key: tool.toolCallId ?? `${part.type}-${index}`,
			kind: "tool",
			status: toolStatus(tool),
			name: tool.toolName ?? part.type.replace(/^tool-/u, ""),
			blocks,
		};
	}
	return null;
}

export function stepsOf(parts: readonly MessagePart[]): Step[] {
	return parts.flatMap((part, index) => stepOf(part, index) ?? []);
}

export function answerOf(parts: readonly MessagePart[]): Answer {
	return parts.reduce<Answer>(
		(answer, part, index) => {
			const step = stepOf(part, index);
			if (step) {
				answer.steps.push(step);
				answer.endsInText = false;
			} else if (part.type === "text" && part.text) {
				answer.endsInText = true;
			}
			return answer;
		},
		{ steps: [], endsInText: false },
	);
}

/**
 * Steps of a turn that has ended: one still marked running was cut off (the reader stopped the
 * turn, or it failed) or simply never got its closing event, so it is settled rather than left to
 * say "Thinking" forever.
 */
export function settleSteps(
	steps: readonly Step[],
	live: boolean,
	interrupted: boolean,
): Step[] {
	if (live) {
		return [...steps];
	}
	return steps.map((step) =>
		step.status === "running"
			? { ...step, status: interrupted ? "error" : "done" }
			: step,
	);
}

/** The last step still running, if any. */
export function runningStep(steps: readonly Step[]): Step | undefined {
	for (let index = steps.length - 1; index >= 0; index--) {
		const step = steps[index];
		if (step?.status === "running") {
			return step;
		}
	}
}

/** A step's title: present tense while it runs, past once it ends. */
export function stepTitle(
	step: Pick<Step, "kind" | "status" | "name">,
): string {
	if (step.kind === "reasoning") {
		return { running: "Thinking", done: "Thought", error: "Stopped thinking" }[
			step.status
		];
	}
	const name = step.name ?? "a tool";
	return {
		running: `Using ${name}`,
		done: `Used ${name}`,
		error: `${name} failed`,
	}[step.status];
}

/** What a step at work says, in turn: its title, then phrases for a long wait. */
export function stepPhrases(step: Step): readonly string[] {
	if (step.status !== "running") {
		return [stepTitle(step)];
	}
	return step.kind === "reasoning"
		? [
				"Thinking",
				"Working out how to answer",
				"Reading the request",
				"Putting ideas in order",
			]
		: [stepTitle(step)];
}

/** What the answer says before anything of it arrives. */
export const WAITING_PHRASES = [
	"Sending the request",
	"Waiting for the model",
	"Preparing the answer",
] as const;
