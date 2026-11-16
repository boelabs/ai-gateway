import type { CanonicalRealtimeTranslationEvent } from "#core/realtimeTranslation.ts";
import type { CanonicalRealtimeConversationEvent } from "#core/realtime.ts";
import { geminiTranslationConversation } from "./google/liveTranslation.ts";
import { makeGeminiRealtimeTranslationHandler } from "./google/liveTranslation.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { type WebSocket, WebSocketServer } from "ws";
import { openaiAdapter } from "./openai/index.ts";
import { googleAdapter } from "./google/index.ts";
import { EventQueue } from "./google/live.ts";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { test } from "node:test";

import type { RealtimeConversationHandler, AdapterContext } from "./types.ts";

import {
	openAIRealtimeTranslationUrl,
	openAITranslationSession,
} from "./openaiRealtime.ts";

import {
	applyTranslationSessionUpdate,
	translationClientEventSchema,
	newTranslationSessionState,
	renderTranslationSession,
	translationConfigOf,
} from "#contracts/openai/realtimeTranslation.ts";

test("translation contract: session.update merges, keeps noise strength, and renders OpenAI's session", () => {
	let state = newTranslationSessionState("translate", 1000);
	state = applyTranslationSessionUpdate(state, {
		audio: {
			input: {
				transcription: { model: "gpt-realtime-whisper" },
				noise_reduction: { type: "near_field", strength: 0.4 },
			},
			output: { language: "es" },
		},
	});
	state = applyTranslationSessionUpdate(state, {
		audio: { input: { noise_reduction: { type: "far_field" } } },
	});
	assert.deepEqual(renderTranslationSession(state), {
		id: state.id,
		type: "translation",
		model: "translate",
		expires_at: 1000,
		audio: {
			input: {
				noise_reduction: { type: "far_field", strength: 0.4 },
				transcription: { model: "gpt-realtime-whisper" },
			},
			output: { language: "es" },
		},
	});
	assert.deepEqual(translationConfigOf(state), {
		model: "translate",
		language: "es",
		inputTranscription: { model: "gpt-realtime-whisper" },
		noiseReduction: { type: "far_field", strength: 0.4 },
	});
	assert.equal(
		translationClientEventSchema.safeParse({ type: "response.create" }).success,
		false,
	);
});

test("translation: both providers serve it, mapped from the same configuration", () => {
	assert.ok(openaiAdapter.realtimeTranslation);
	assert.ok(googleAdapter.realtimeTranslation);
	assert.equal(
		openAIRealtimeTranslationUrl(
			"https://api.openai.com/v1",
			"gpt-realtime-translate",
		),
		"wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
	);
	const config = {
		model: "translate",
		language: "fr",
		inputTranscription: {},
		noiseReduction: { type: "near_field" as const },
	};
	assert.deepEqual(
		openAITranslationSession(config, { supportsNoiseReduction: true }),
		{
			audio: {
				input: {
					transcription: { model: "gpt-realtime-whisper" },
					noise_reduction: { type: "near_field" },
				},
				output: { language: "fr" },
			},
		},
	);
	const conversation = geminiTranslationConversation(config);
	assert.deepEqual(conversation.translation, { targetLanguage: "fr" });
	assert.deepEqual(conversation.inputTranscription, {});
	assert.equal(
		geminiTranslationConversation({
			model: "translate",
			inputTranscription: null,
			noiseReduction: null,
		}).translation?.targetLanguage,
		"en",
	);
	const gemini = resolveModelMetadata(
		"googleaistudio",
		"gemini-3.5-live-translate-preview",
	);
	assert.ok(
		gemini.operations?.["audio.translate.realtime"]?.languages?.includes(
			"pt-BR",
		),
	);
});

test("openai translation: a session configures itself, streams 200 ms frames and drains on finish", async () => {
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
			if (event.type === "session.close") {
				socket.send(
					JSON.stringify({
						type: "session.output_transcript.delta",
						delta: "Hola.",
						elapsed_ms: 200,
					}),
				);
				socket.send(JSON.stringify({ type: "session.closed" }));
			}
		});
	});
	const { port } = server.address() as AddressInfo;
	const ctx: AdapterContext = {
		upstreamModel: "gpt-realtime-translate",
		credentials: { apiKey: "sk-test", baseUrl: `http://127.0.0.1:${port}/v1` },
		meta: resolveModelMetadata("openai", "gpt-realtime-translate"),
		transport: "realtime",
		requestId: "t",
	};
	try {
		const handler = openaiAdapter.realtimeTranslation;
		assert.ok(handler);
		const session = await handler.connect(
			{
				model: "public",
				language: "es",
				inputTranscription: null,
				noiseReduction: null,
			},
			ctx,
		);
		assert.equal(
			path,
			"/v1/realtime/translations?model=gpt-realtime-translate",
		);
		assert.deepEqual(received[0]?.session.audio.output, { language: "es" });
		const events: CanonicalRealtimeTranslationEvent[] = [];
		const reading = (async () => {
			for await (const event of session.events) {
				events.push(event);
			}
		})();
		// 200 ms at 24 kHz is one frame.
		session.appendAudio(Buffer.alloc(9600));
		upstream?.send(
			JSON.stringify({
				type: "session.output_audio.delta",
				delta: Buffer.alloc(480).toString("base64"),
				elapsed_ms: 0,
			}),
		);
		await session.finish();
		await reading;
		assert.deepEqual(
			received.slice(1).map((event) => event.type),
			["session.input_audio_buffer.append", "session.close"],
		);
		assert.equal(Buffer.from(received[1]?.audio, "base64").byteLength, 9600);
		assert.deepEqual(
			events.map((event) => event.kind),
			["output_audio", "output_transcript"],
		);
	} finally {
		for (const client of server.clients) {
			client.terminate();
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("gemini translation: 24 kHz audio goes in at 16 kHz and only the translation's events come out", async () => {
	const appended: Buffer[] = [];
	const configs: unknown[] = [];
	const upstream = new EventQueue<CanonicalRealtimeConversationEvent>();
	const conversation: RealtimeConversationHandler = {
		connect(config) {
			configs.push(config);
			return Promise.resolve({
				appendAudio: (pcm) => appended.push(pcm),
				startActivity: () => undefined,
				endActivity: () => undefined,
				flushAudio: () => undefined,
				sendTurns: () => undefined,
				sendFunctionResults: () => undefined,
				reconfigure: (next) => {
					configs.push(next);
					return Promise.resolve();
				},
				events: upstream.iterate(),
				close: () => upstream.end(),
			});
		},
	};
	const handler = makeGeminiRealtimeTranslationHandler(conversation);
	const session = await handler.connect(
		{
			model: "translate",
			language: "de",
			inputTranscription: {},
			noiseReduction: null,
		},
		{} as AdapterContext,
	);
	session.appendAudio(Buffer.alloc(4800));
	const resampled = appended.reduce((total, pcm) => total + pcm.byteLength, 0);
	assert.ok(Math.abs(resampled - 3200) <= 4, String(resampled));
	upstream.push({ kind: "speech_started" });
	upstream.push({ kind: "input_transcript", text: "Hallo" });
	upstream.push({ kind: "output_audio", pcm: Buffer.alloc(480) });
	upstream.push({ kind: "turn_complete" });
	await session.reconfigure({
		model: "translate",
		language: "it",
		inputTranscription: null,
		noiseReduction: null,
	});
	const events: CanonicalRealtimeTranslationEvent[] = [];
	const reading = (async () => {
		for await (const event of session.events) {
			events.push(event);
		}
	})();
	// Closing drops what is still queued, so let the queued events through first.
	await new Promise((resolve) => setTimeout(resolve, 20));
	session.close();
	await reading;
	assert.deepEqual(
		events.map((event) => event.kind),
		["input_transcript", "output_audio"],
	);
	assert.equal(
		(configs[1] as { translation: { targetLanguage: string } }).translation
			.targetLanguage,
		"it",
	);
});
