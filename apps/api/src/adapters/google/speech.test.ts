import { jsonBody, must } from "#test-support/adapters.ts";
import type { CanonicalSpeechRequest } from "#core/speech.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { pcmToWav, readWav } from "#core/speech.ts";
import { GatewayError } from "#core/errors.ts";
import { googleAdapter } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const ctx: AdapterContext = {
	upstreamModel: "gemini-3.8-flash-tts",
	credentials: { apiKey: "AIza-test" },
	meta: {
		capabilities: {
			tools: false,
			vision: false,
			reasoning: false,
			structuredOutputs: false,
		},
		operations: {
			"audio.speech": {
				responseFormats: ["wav", "pcm"],
				supportsInstructions: true,
			},
		},
	},
	transport: "generate_content",
	requestId: "t",
};

const req: CanonicalSpeechRequest = {
	model: "tts",
	input: "Have a wonderful day!",
	voice: "Kore",
	instructions: "cheerful and friendly",
};

const speech = must(googleAdapter, "speech");
const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

function answer(data: Uint8Array, mimeType: string, extra = {}) {
	return {
		candidates: [
			{
				content: {
					parts: [
						{
							inlineData: {
								mimeType,
								data: Buffer.from(data).toString("base64"),
							},
						},
					],
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: {
			promptTokenCount: 10,
			candidatesTokenCount: 50,
			totalTokenCount: 60,
			candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }],
		},
		...extra,
	};
}

test("google speech: generateContent with the voice, style and WAV output", () => {
	const request = speech.buildRequest(req, ctx);
	assert.equal(
		request.url,
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent",
	);
	assert.deepEqual(jsonBody(request), {
		contents: [
			{
				role: "user",
				parts: [
					{
						text: "Have a wonderful day!",
						speech_metadata: { style: "cheerful and friendly" },
					},
				],
			},
		],
		generationConfig: {
			responseModalities: ["AUDIO"],
			responseFormat: { audio: { mimeType: "AUDIO_WAV", sampleRate: 24_000 } },
			speechConfig: { voiceConfig: { voice: "Kore" } },
		},
	});
});

test("google speech: pcm asks for AUDIO_L16 and a service mode adds service_tier", () => {
	const body = jsonBody(
		speech.buildRequest(
			{ model: "tts", input: "Hi", voice: "Kore", responseFormat: "pcm" },
			{ ...ctx, serviceMode: "flex" },
		),
	);
	assert.equal(
		body.generationConfig.responseFormat.audio.mimeType,
		"AUDIO_L16",
	);
	assert.equal(body.contents[0].parts[0].speech_metadata, undefined);
	assert.equal(body.service_tier, "flex");
});

test("google speech: returns the WAV as given and bills audio output tokens", () => {
	const wav = pcmToWav(pcm, 24_000);
	const response = speech.parseResponse(answer(wav, "audio/wav"), ctx, req);
	assert.equal(response.format, "wav");
	assert.deepEqual(readWav(response.audio)?.pcm, pcm);
	assert.equal(response.usage?.promptTokens, 10);
	assert.equal(response.usage?.completionAudioTokens, 50);
});

test("google speech: converts between raw PCM and WAV when Gemini answers in the other one", () => {
	const wrapped = speech.parseResponse(
		answer(pcm, "audio/L16;codec=pcm;rate=16000"),
		ctx,
		req,
	);
	assert.deepEqual(readWav(wrapped.audio)?.pcm, pcm);
	assert.equal(readWav(wrapped.audio)?.sampleRate, 16_000);

	const unwrapped = speech.parseResponse(
		answer(pcmToWav(pcm, 24_000), "audio/wav"),
		ctx,
		{ ...req, responseFormat: "pcm" },
	);
	assert.equal(unwrapped.format, "pcm");
	assert.deepEqual(unwrapped.audio, pcm);
});

test("google speech: a blocked input is a content-policy error, Flex usage is billed at Flex", () => {
	assert.throws(
		() =>
			speech.parseResponse(
				{ promptFeedback: { blockReason: "SAFETY" } },
				ctx,
				req,
			),
		(error: unknown) =>
			error instanceof GatewayError && error.class === "content_policy",
	);
	const flex = speech.parseResponse(
		answer(pcmToWav(pcm, 24_000), "audio/wav"),
		{ ...ctx, serviceMode: "flex" },
		req,
	);
	assert.equal(flex.usage?.serviceTier, "flex");
});
