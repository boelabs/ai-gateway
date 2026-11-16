import type { CanonicalRealtimeTranscriptionEvent } from "#core/realtime.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { type WebSocket, WebSocketServer } from "ws";
import { openaiAdapter } from "./openai/index.ts";
import type { AdapterContext } from "./types.ts";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	openAIRealtimeTranscriptionUrl,
	openAITranscriptionSession,
	OpenAITranscriptOrder,
} from "./openaiRealtime.ts";

const MODEL = "gpt-live-transcribe";

test("openai transcription: the adapter serves gpt-live-transcribe over the transcription intent", () => {
	assert.ok(openaiAdapter.supportedCallTypes.has("realtime.transcription"));
	assert.equal(
		openAIRealtimeTranscriptionUrl("https://api.openai.com/v1"),
		"wss://api.openai.com/v1/realtime?intent=transcription",
	);
	const meta = resolveModelMetadata("openai", MODEL);
	assert.deepEqual(
		meta.operations?.["audio.transcribe.realtime"]?.turnDetection,
		["manual"],
	);
});

test("openai transcription: the session sends languages as a list and keywords only when declared", () => {
	const config = {
		model: "public",
		language: "es",
		keywords: ["AI Gateway"],
		turnDetection: "manual" as const,
	};
	assert.deepEqual(
		openAITranscriptionSession(config, MODEL, {
			supportsLanguageHints: true,
			supportsKeywords: true,
		}),
		{
			type: "transcription",
			audio: {
				input: {
					format: { type: "audio/pcm", rate: 24_000 },
					transcription: {
						model: MODEL,
						languages: ["es"],
						keywords: ["AI Gateway"],
					},
					turn_detection: null,
				},
			},
		},
	);
	const plain = openAITranscriptionSession(
		{ ...config, turnDetection: "server_vad" },
		"gpt-transcribe",
		undefined,
	) as { audio: { input: Record<string, unknown> } };
	assert.deepEqual(plain.audio.input.transcription, {
		model: "gpt-transcribe",
		language: "es",
	});
	assert.deepEqual(plain.audio.input.turn_detection, { type: "server_vad" });
});

test("openai transcription: transcripts leave in commit order, whatever order they finish in", () => {
	const order = new OpenAITranscriptOrder();
	order.committed("a");
	order.committed("b");
	assert.deepEqual(order.delta("a", "Hola"), [
		{ kind: "interim", text: "Hola" },
	]);
	// The second utterance streams before the first is final: it waits.
	assert.deepEqual(order.delta("b", "Adiós"), []);
	assert.deepEqual(order.completed("b", "Adiós."), []);
	assert.deepEqual(order.delta("a", " mundo"), [
		{ kind: "interim", text: "Hola mundo" },
	]);
	assert.deepEqual(order.completed("a", "Hola mundo."), [
		{ kind: "final", text: "Hola mundo." },
		{ kind: "final", text: "Adiós." },
	]);
});

test("openai transcription: a session configures itself, streams 24 kHz audio and transcribes a commit", async () => {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const received: Record<string, any>[] = [];
	let upstream: WebSocket | undefined;
	let path = "";
	server.on("connection", (socket, request) => {
		upstream = socket;
		path = request.url ?? "";
		socket.send(JSON.stringify({ type: "session.created", session: {} }));
		socket.on("message", (data) => {
			const event = JSON.parse(data.toString()) as Record<string, any>;
			received.push(event);
			if (event.type === "session.update") {
				socket.send(
					JSON.stringify({ type: "session.updated", session: event.session }),
				);
			}
		});
	});
	const { port } = server.address() as AddressInfo;
	const ctx: AdapterContext = {
		upstreamModel: MODEL,
		credentials: { apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1` },
		meta: resolveModelMetadata("openai", MODEL),
		transport: "realtime",
		requestId: "t",
	};
	try {
		const handler = openaiAdapter.realtimeTranscription;
		assert.ok(handler);
		const session = await handler.connect(
			{ model: "public", languages: ["es"], turnDetection: "manual" },
			ctx,
		);
		assert.equal(path, "/v1/realtime?intent=transcription");
		assert.equal(received[0]?.session.type, "transcription");
		assert.deepEqual(received[0]?.session.audio.input.transcription, {
			model: MODEL,
			languages: ["es"],
		});
		const events: CanonicalRealtimeTranscriptionEvent[] = [];
		const reading = (async () => {
			for await (const event of session.events) {
				events.push(event);
			}
		})();

		// 100 ms at 16 kHz goes up as 100 ms at 24 kHz, then the commit.
		session.startUtterance();
		session.appendAudio(Buffer.alloc(3200));
		session.endUtterance();
		const deadline = Date.now() + 2000;
		while (received.length < 3 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.deepEqual(
			received.slice(1).map((event) => event.type),
			["input_audio_buffer.append", "input_audio_buffer.commit"],
		);
		// The resampler keeps a couple of bytes back for the next chunk.
		const sent = Buffer.from(received[1]?.audio, "base64").byteLength;
		assert.ok(Math.abs(sent - 4800) <= 4, String(sent));

		for (const event of [
			{ type: "input_audio_buffer.committed", item_id: "item_1" },
			{
				type: "conversation.item.input_audio_transcription.delta",
				item_id: "item_1",
				delta: "Hola",
			},
			{
				type: "conversation.item.input_audio_transcription.completed",
				item_id: "item_1",
				transcript: "Hola.",
				usage: { type: "duration", seconds: 0.1 },
			},
		]) {
			upstream?.send(JSON.stringify(event));
		}
		while (events.length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.deepEqual(events, [
			{ kind: "interim", text: "Hola" },
			{ kind: "final", text: "Hola." },
		]);
		session.close();
		await reading;
	} finally {
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
