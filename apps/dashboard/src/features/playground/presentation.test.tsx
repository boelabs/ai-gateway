import { composerExpanded, composerTextareaGeometry } from "./composerLayout";
import { Conversation, groupMessages } from "./Conversation";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaygroundMessage } from "./transport";
import type { PlaygroundModel } from "./models";
import { VideoRunView } from "./VideoRunView";
import { ModelSelect } from "./ModelSelect";
import { Metrics } from "./ResponseDetails";
import type { VideoRun } from "./videos";
import assert from "node:assert/strict";
import { Markdown } from "./Markdown";
import { ProcessTrace } from "./Process";
import { stepsOf } from "./steps";
import { test } from "node:test";

const messages: PlaygroundMessage[] = [
	{ id: "u1", role: "user", parts: [{ type: "text", text: "First question" }] },
	{
		id: "a1",
		role: "assistant",
		parts: [{ type: "text", text: "First answer" }],
	},
	{
		id: "u2",
		role: "user",
		parts: [{ type: "text", text: "Second question" }],
	},
];

test("composer expands on wrapping and latches until the draft is empty", () => {
	assert.equal(composerExpanded("Short", 42, false), false);
	assert.equal(composerExpanded("Wrapped text", 68, false), true);
	assert.equal(composerExpanded("Short", 42, true), true);
	assert.equal(composerExpanded("", 42, true), false);
});

test("clearing a tall draft resets geometry and layout in the same render", () => {
	const geometry = composerTextareaGeometry("", 260, 208);
	assert.deepEqual(geometry, {
		contentHeight: 42,
		height: 42,
		overflowY: "hidden",
	});
	assert.equal(composerExpanded("", geometry.contentHeight, true), false);
});

test("layout uses intrinsic content height while the editor caps scrolling", () => {
	assert.deepEqual(composerTextareaGeometry("Long draft", 260, 208), {
		contentHeight: 260,
		height: 208,
		overflowY: "auto",
	});
	assert.deepEqual(composerTextareaGeometry("Long draft", 260, 77), {
		contentHeight: 260,
		height: 77,
		overflowY: "auto",
	});
});

test("conversation groups each answer with its question and retains pending turns", () => {
	assert.deepEqual(groupMessages(messages), [
		messages.slice(0, 2),
		messages.slice(2),
	]);
	assert.deepEqual(groupMessages([]), []);
	assert.deepEqual(groupMessages(messages.slice(1)), [
		[messages[1]],
		[messages[2]],
	]);
});

test("pending response reserves disabled actions and places the loader inside the assistant", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy
			messages={messages}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.match(html, /Sending the request/u);
	assert.match(
		html,
		/<button(?=[^>]*aria-label="Regenerate response")(?=[^>]*disabled)[^>]*>/u,
	);
	assert.match(
		html,
		/<article aria-label="Assistant message"[^>]*><div[^>]*data-role="waiting"[^>]*><span(?=[^>]*role="status")[^>]*>/u,
	);
	assert.equal((html.match(/aria-label="Copy message"/gu) ?? []).length, 2);
	assert.equal((html.match(/aria-label="Copy response"/gu) ?? []).length, 2);
});

test("every settled answer can be regenerated and metrics are accessed through an info dialog", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			messages={[
				...messages,
				{
					id: "a2",
					role: "assistant",
					parts: [{ type: "text", text: "Second answer" }],
					metadata: { outputTokens: 15 },
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.equal(
		(html.match(/aria-label="Regenerate response"/gu) ?? []).length,
		2,
	);
	assert.match(html, /Response details/u);
	assert.doesNotMatch(html, /Output tokens/u);
	assert.doesNotMatch(html, /<summary[^>]*>Response details/u);
	const details = renderToStaticMarkup(
		<Metrics metrics={{ outputTokens: 15 }} />,
	);
	assert.match(details, /Output tokens/u);
	assert.match(details, />15</u);
	assert.doesNotMatch(html, /Generating response/u);
});

for (const busy of [true, false]) {
	test(`streaming responses disable all actions even when busy is ${busy}`, () => {
		const html = renderToStaticMarkup(
			<Conversation
				busy={busy}
				messages={[
					{
						id: "active",
						role: "assistant",
						parts: [
							{ type: "text", text: "Partial answer", state: "streaming" },
						],
						metadata: { state: "streaming", outputTokens: 2 },
					},
				]}
				onCopy={async () => {
					/* intentionally empty */
				}}
				onRegenerate={() => {
					/* intentionally empty */
				}}
			/>,
		);
		assert.match(html, /Partial/u);
		for (const label of [
			"Copy response",
			"Regenerate response",
			"Response details",
		]) {
			assert.match(
				html,
				new RegExp(
					`<button(?=[^>]*aria-label="${label}")(?=[^>]*disabled)[^>]*>`,
					"u",
				),
			);
		}
		assert.match(html, /pointer-events-none/u);
	});
}

test("active responses without metadata reserve actions while earlier answers stay available", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy
			messages={[
				...messages,
				{
					id: "active",
					role: "assistant",
					parts: [{ type: "text", text: "Partial answer" }],
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.equal((html.match(/aria-label="Copy response"/gu) ?? []).length, 2);
});

for (const state of ["completed", "stopped", "failed"] as const) {
	test(`terminal ${state} responses expose their actions`, () => {
		const html = renderToStaticMarkup(
			<Conversation
				busy={false}
				messages={[
					{
						id: "done",
						role: "assistant",
						parts: [{ type: "text", text: "Answer" }],
						metadata: { state },
					},
				]}
				onCopy={async () => {
					/* intentionally empty */
				}}
				onRegenerate={() => {
					/* intentionally empty */
				}}
			/>,
		);
		assert.match(html, /Copy response/u);
		assert.match(html, /Regenerate response/u);
		assert.match(html, /Response details/u);
	});
}

test("Streamdown renders GFM, fenced code and math", () => {
	const text =
		"# Heading\n\n**Bold** and ~~removed~~\n\n| Column |\n| --- |\n| Value |\n\n- [x] Task\n\n" +
		"```ts\nconst value = 1;\n```\n\n$$\nx^2\n$$";
	const html = renderToStaticMarkup(<Markdown text={text} />);
	assert.match(html, /<h1/u);
	assert.match(html, /data-streamdown="strong"[^>]*>Bold/u);
	assert.match(html, /<del[^>]*>removed/u);
	assert.match(html, /<table/u);
	assert.match(html, /type="checkbox"/u);
	assert.match(html, /data-language="ts"/u);
	assert.match(html, /class="katex"/u);
});

test("streaming repairs unfinished emphasis and reasoning uses Markdown", () => {
	const html = renderToStaticMarkup(
		<Markdown streaming text="An **unfinished" />,
	);
	assert.match(html, /data-streamdown="strong"/u);
	// Reasoning is read in the process panel, where each step's text is Markdown.
	const reasoning = renderToStaticMarkup(
		<ProcessTrace
			steps={stepsOf([
				{ type: "reasoning", text: "**Reasoning**", state: "done" },
			])}
		/>,
	);
	assert.match(reasoning, /data-streamdown="strong"[^>]*>Reasoning/u);
});

test("complete Markdown keeps identical layout during streaming and after completion", () => {
	const text =
		"First paragraph.\n\nSecond paragraph.\n\n## Heading\n\n- One\n- Two";
	const active = renderToStaticMarkup(<Markdown streaming text={text} />);
	const completed = renderToStaticMarkup(<Markdown text={text} />);
	assert.equal(active, completed);
	assert.doesNotMatch(active, /display:contents|data-sd-animate/u);
	assert.equal(
		(active.match(/class="playground-markdown-block min-w-0"/gu) ?? []).length,
		4,
	);
});

test("an empty assistant uses one loader in its content slot", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy
			messages={[
				...messages,
				{
					id: "pending",
					role: "assistant",
					parts: [{ type: "text", text: "" }],
					metadata: { state: "streaming" },
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.equal((html.match(/role="status"/gu) ?? []).length, 1);
	// One thinking glyph: the sparkle and its twinkle, drawn once.
	assert.equal((html.match(/data-role="waiting"/gu) ?? []).length, 1);
	assert.match(
		html,
		/<article aria-label="Assistant message"[^>]*><div[^>]*data-role="waiting"[^>]*><span(?=[^>]*role="status")[^>]*>/u,
	);
});

test("reasoning starts visibly before text arrives and replaces the generic loader", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy
			messages={[
				{
					id: "r",
					role: "assistant",
					metadata: { state: "streaming" },
					parts: [{ type: "reasoning", text: "", state: "streaming" }],
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	// The process row takes the loader's line: it says what the model is doing, on the same glyph.
	assert.match(html, /Thinking…/u);
	assert.doesNotMatch(html, /data-role="waiting"/u);
	assert.equal((html.match(/role="status"/gu) ?? []).length, 1);
	assert.match(html, /<button[^>]*aria-expanded="false"/u);
	assert.doesNotMatch(html, /Done in/u);
});

test("interrupted reasoning is settled, not left thinking", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			messages={[
				{
					id: "r",
					role: "assistant",
					metadata: { state: "stopped" },
					parts: [
						{
							type: "reasoning",
							text: "**Partial thought**",
							state: "streaming",
						},
						{ type: "text", text: "Partial answer" },
					],
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.match(html, /Stopped after 1 step/u);
	assert.doesNotMatch(html, /Thinking/u);
	assert.doesNotMatch(html, /role="status"/u);
	// Its text is the panel's, not the transcript's.
	assert.doesNotMatch(html, /Partial thought/u);
	assert.match(html, /Partial answer/u);
});

test("one process row covers every step of an answer, wherever the model took it", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			messages={[
				{
					id: "chain",
					role: "assistant",
					parts: [
						{ type: "step-start" },
						{ type: "reasoning", text: "First thought", state: "done" },
						{ type: "step-start" },
						{ type: "reasoning", text: "Second thought", state: "done" },
						{ type: "text", text: "First answer" },
						{ type: "reasoning", text: "Third thought", state: "done" },
						{ type: "text", text: "Second answer" },
					],
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.equal((html.match(/Done in 3 steps/gu) ?? []).length, 2);
	assert.doesNotMatch(html, /First thought|Second thought|Third thought/u);
	assert.ok(html.indexOf("Done in 3 steps") < html.indexOf("First answer"));
	assert.ok(html.indexOf("First answer") < html.indexOf("Second answer"));
});

test("empty reasoning steps still count and show without detail", () => {
	const parts: PlaygroundMessage["parts"] = [
		{ type: "reasoning", text: "", state: "done" },
		{ type: "reasoning", text: "  ", state: "done" },
		{ type: "text", text: "Answer" },
	];
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			messages={[{ id: "r", role: "assistant", parts }]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.match(html, /Done in 2 steps/u);
	assert.match(html, /Answer/u);
	const trace = renderToStaticMarkup(<ProcessTrace steps={stepsOf(parts)} />);
	assert.equal((trace.match(/>Thought</gu) ?? []).length, 2);
	// No detail to open: a step without text is a plain line, not a collapsible.
	assert.doesNotMatch(trace, /data-slot="trace-collapsible"/u);
});

test("once the answer starts, the row says it is writing and sits above the text", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy
			messages={[
				{
					id: "r",
					role: "assistant",
					metadata: { state: "streaming" },
					parts: [
						{
							type: "reasoning",
							text: "Considered the options.",
							state: "done",
						},
						{ type: "text", text: "Answer", state: "streaming" },
					],
				},
			]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.match(html, /Writing the answer…/u);
	assert.doesNotMatch(html, /Considered the options\./u);
	assert.ok(html.indexOf("Writing the answer") < html.indexOf(">Answer<"));
});

test("a failed response is reported inside its own turn, above its regenerate button", () => {
	const failed: PlaygroundMessage[] = [
		messages[0],
		{ id: "a1", role: "assistant", parts: [], metadata: { state: "failed" } },
	];
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			error="Failed to construct 'URL': Invalid URL"
			messages={failed}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	const alert = html.indexOf('role="alert"');
	assert.notEqual(alert, -1);
	assert.match(html, /Failed to construct &#x27;URL&#x27;: Invalid URL/u);
	// Inside the assistant article, and before the actions that retry it.
	assert.ok(alert > html.indexOf('aria-label="Assistant message"'));
	assert.ok(alert < html.indexOf('aria-label="Regenerate response"'));
	assert.doesNotMatch(html, /disabled[^>]*aria-label="Regenerate response"/u);
});

test("a failure that left no turn behind still reports itself in the transcript", () => {
	const html = renderToStaticMarkup(
		<Conversation
			busy={false}
			error="The inference request failed."
			messages={[messages[0]]}
			onCopy={async () => {
				/* intentionally empty */
			}}
			onRegenerate={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.equal((html.match(/role="alert"/gu) ?? []).length, 1);
	assert.match(html, /The inference request failed\./u);
});

test("the model picker names the current model and is reachable as a labelled control", () => {
	const model: PlaygroundModel = {
		id: "gpt-5",
		capabilities: ["text"],
		operations: ["text.generate"],
		endpoints: ["chat.completions"],
		acceptsImages: false,
		supportedParameters: [],
		inputModalities: ["text"],
		parameterConstraints: {},
		reasoningEfforts: [],
	};
	const html = renderToStaticMarkup(
		<ModelSelect
			capability="text"
			modelId="gpt-5"
			models={[model, { ...model, id: "claude-opus-5" }]}
			onSelect={() => {
				/* intentionally empty */
			}}
		/>,
	);
	assert.match(html, /aria-label="Model: gpt-5"/u);
	assert.match(html, /gpt-5/u);
	// The list lives in a portal, so the closed trigger must not leak the other names.
	assert.doesNotMatch(html, /claude-opus-5/u);
});

const videoRun: VideoRun = {
	id: "run-1",
	prompt: "A fox crossing a frozen river",
	references: [],
	model: "sora-2",
	settings: { seconds: 8, aspectRatio: "16:9" },
	state: "running",
};

test("a queued job waits behind the same loader as every other capability", () => {
	const html = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={videoRun}
		/>,
	);
	assert.match(html, /Queued/u);
	assert.doesNotMatch(html, /<video/u);
	assert.match(html, /disabled[^>]*aria-label="Generate again"/u);
});

test("reported progress becomes a bar, and an unreported one does not", () => {
	const withProgress = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={{
				...videoRun,
				job: { id: "video_1", status: "in_progress", progress: 42 },
			}}
		/>,
	);
	assert.match(withProgress, /aria-valuenow="42"/u);
	assert.match(withProgress, /Generating/u);
	const without = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={{ ...videoRun, job: { id: "video_1", status: "in_progress" } }}
		/>,
	);
	assert.doesNotMatch(without, /aria-valuenow/u);
});

test("a finished video plays from the relay rather than from a blob", () => {
	const html = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={{
				...videoRun,
				state: "completed",
				job: { id: "video_1", status: "completed" },
				durationMs: 94_000,
			}}
		/>,
	);
	assert.match(
		html,
		/src="\/api\/v1\/videos\/video_1\/content\?variant=video"/u,
	);
	assert.match(html, /aria-label="Download video"/u);
	assert.match(html, /sora-2 · 8s · 16:9 · 94\.0s/u);
	assert.doesNotMatch(html, /aria-label="Check this job again"/u);
});

test("a stopped run keeps its job, and says the provider has not stopped with it", () => {
	const html = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={{
				...videoRun,
				state: "stopped",
				job: { id: "video_1", status: "in_progress" },
			}}
		/>,
	);
	assert.match(html, /Stopped watching/u);
	assert.match(html, /may still be running on the provider/u);
	assert.match(html, /aria-label="Check this job again"/u);
});

test("a failed job reports what the gateway said, and offers no player", () => {
	const html = renderToStaticMarkup(
		<VideoRunView
			onCheck={() => {
				/* intentionally empty */
			}}
			onRetry={() => {
				/* intentionally empty */
			}}
			run={{
				...videoRun,
				state: "failed",
				job: { id: "video_1", status: "failed" },
				error: "The provider rejected the prompt.",
			}}
		/>,
	);
	assert.match(html, /role="alert"/u);
	assert.match(html, /The provider rejected the prompt\./u);
	assert.doesNotMatch(html, /<video/u);
});
