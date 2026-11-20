import { publicApi } from "#/shared/api/client.ts";
import { afterEach, mock, test } from "node:test";
import { fetchPublicModels } from "./catalog.ts";
import assert from "node:assert/strict";

import {
	reasoningEffortsFor,
	parsePublicModels,
	capabilityGroups,
	parameterValues,
	capabilitiesFor,
	tunablesFor,
	supports,
} from "./models.ts";

afterEach(() => mock.restoreAll());

function model(overrides: Record<string, unknown> = {}) {
	return {
		id: "public-model",
		operations: [
			{
				id: "text.generate",
				endpoints: ["/v1/chat/completions", "/v1/responses", "/v1/messages"],
			},
		],
		text_capabilities: {
			contracts: ["chat.completions", "responses", "messages"],
			supported_parameters: [
				"temperature",
				"top_p",
				"top_k",
				"max_tokens",
				"seed",
				"stop",
				"reasoning",
				"reasoning_effort",
			],
			input_modalities: ["text", "image", "pdf"],
			parameter_constraints: { temperature: { min: 0.2, max: 0.8 } },
			reasoning_efforts: ["high", "none"],
			max_output_tokens: 512,
			...overrides,
		},
	};
}

test("parses actual operation objects and reads each model's contracts", () => {
	const models = parsePublicModels({
		data: [
			model(),
			{
				id: "image",
				operations: [
					{ id: "image.generate", endpoints: ["/v1/images/generations"] },
				],
			},
		],
	});
	assert.deepEqual(
		models.map((entry) => entry.capabilities),
		[["image"], ["text"]],
	);
	assert.deepEqual(models[1]?.endpoints, [
		"chat.completions",
		"responses",
		"messages",
	]);
	assert.deepEqual(models[1]?.reasoningEfforts, ["none", "high"]);
	assert.equal(models[1]?.acceptsImages, true);
});

test("effective contract and parameter availability applies separately to each endpoint", () => {
	const [parsed] = parsePublicModels({
		data: [model({ contracts: ["messages", "responses"] })],
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.endpoints, ["responses", "messages"]);
	assert.equal(supports(parsed, "stop", "responses"), false);
	assert.equal(supports(parsed, "stop", "messages"), true);
	assert.equal(supports(parsed, "seed", "messages"), false);
	assert.equal(supports(parsed, "top_k", "messages"), true);
	assert.deepEqual(reasoningEffortsFor(parsed, "chat.completions"), []);
	assert.deepEqual(
		capabilitiesFor(parsed, "chat.completions").inputModalities,
		[],
	);
});

test("controls honor effective numeric limits instead of provider model-name guesses", () => {
	const [parsed] = parsePublicModels({ data: [model()] });
	assert.ok(parsed);
	const controls = tunablesFor(parsed, "responses");
	assert.deepEqual(
		controls.find((control) => control.key === "temperature"),
		{
			key: "temperature",
			label: "Temperature",
			min: 0.2,
			max: 0.8,
			step: 0.05,
			fallback: 0.8,
		},
	);
	assert.equal(
		controls.find((control) => control.key === "max_tokens")?.max,
		512,
	);
	assert.equal(
		controls.find((control) => control.key === "max_tokens")?.fallback,
		512,
	);
	assert.equal(
		controls.some((control) => control.key === "top_k"),
		false,
	);
});

test("only exposes attachment modalities supported by the selected wire contract", () => {
	const [parsed] = parsePublicModels({
		data: [
			model({ input_modalities: ["text", "image", "pdf", "audio", "video"] }),
		],
	});
	assert.ok(parsed);
	assert.deepEqual(
		capabilitiesFor(parsed, "chat.completions").inputModalities,
		["text", "image", "pdf", "audio"],
	);
	assert.deepEqual(capabilitiesFor(parsed, "responses").inputModalities, [
		"text",
		"image",
		"pdf",
	]);
});

test("discrete token limits respect effective output limits", () => {
	const [parsed] = parsePublicModels({
		data: [
			model({
				parameter_constraints: { max_tokens: { values: [0, 128, 256, 1024] } },
			}),
		],
	});
	assert.ok(parsed);
	assert.deepEqual(parameterValues(parsed, "max_tokens"), [128, 256]);
});

test("unknown optional metadata does not claim union capabilities are safe across the pool", () => {
	const [parsed] = parsePublicModels({
		data: [
			{
				id: "legacy",
				operations: model().operations,
				supported_parameters: ["temperature"],
				architecture: { input_modalities: ["image"] },
			},
		],
	});
	assert.ok(parsed);
	assert.deepEqual(parsed.supportedParameters, []);
	assert.deepEqual(parsed.reasoningEfforts, []);
	assert.equal(parsed.acceptsImages, false);
});

test("malformed responses and request errors surface rather than becoming empty model lists", async () => {
	assert.throws(() =>
		parsePublicModels({ data: [{ id: "invalid", operations: ["chat"] }] }),
	);
	assert.throws(() => parsePublicModels({}));
	assert.deepEqual(parsePublicModels({ data: [] }), []);
	mock.method(publicApi, "GET", async () => ({
		error: { error: { message: "Discovery unavailable" } },
		response: new Response(null, { status: 503 }),
	}));
	await assert.rejects(fetchPublicModels(), /Discovery unavailable/u);
});

test("fetches only public model discovery and preserves successful empty responses", async () => {
	mock.method(publicApi, "GET", async (path: string) => {
		assert.equal(path, "/v1/models");
		return { data: { data: [] }, response: new Response() };
	});
	assert.deepEqual(await fetchPublicModels(), []);
});

test("a missing response body and transport failures are not mistaken for no models", async () => {
	mock.method(publicApi, "GET", async () => ({ response: new Response() }));
	await assert.rejects(fetchPublicModels(), /empty response/u);
	mock.restoreAll();
	mock.method(publicApi, "GET", async () => {
		throw new Error("Network unavailable");
	});
	await assert.rejects(fetchPublicModels(), /Network unavailable/u);
});

test("incompatible numeric constraints and discrete enumerations never produce invalid sliders", () => {
	const [parsed] = parsePublicModels({
		data: [
			model({
				parameter_constraints: {
					temperature: { min: 1, max: 0 },
					top_p: { values: [0.5, 1] },
				},
			}),
		],
	});
	assert.ok(parsed);
	const controls = tunablesFor(parsed, "responses");
	assert.equal(
		controls.some((control) => control.key === "temperature"),
		false,
	);
	assert.equal(
		controls.some((control) => control.key === "top_p"),
		false,
	);
});

test("a model is listed under every capability it exposes, and under none it cannot run", () => {
	const models = parsePublicModels({
		data: [
			model(),
			{
				id: "image-only",
				operations: [
					{ id: "image.generate", endpoints: ["/v1/images/generations"] },
				],
			},
			{
				id: "declared-but-unreachable",
				operations: [{ id: "text.generate", endpoints: [] }],
			},
		],
	});
	assert.deepEqual(
		models.map((entry) => entry.id),
		["image-only", "public-model"],
	);
	assert.deepEqual(models[1]?.capabilities, ["text"]);
	// The unreachable model is gone; the image model is offered under Images and nowhere else.
	assert.deepEqual(
		capabilityGroups(models).map((group) => ({
			capability: group.capability,
			items: group.items.map((item) => item.key),
		})),
		[
			{ capability: "text", items: ["text:public-model"] },
			{ capability: "image", items: ["image:image-only"] },
		],
	);
});

test("a model that both writes and draws is offered under each, as separate choices", () => {
	const models = parsePublicModels({
		data: [
			{
				...model(),
				operations: [
					{
						id: "text.generate",
						endpoints: [
							"/v1/chat/completions",
							"/v1/responses",
							"/v1/messages",
						],
					},
					{ id: "image.generate", endpoints: ["/v1/images/generations"] },
					{ id: "image.edit", endpoints: ["/v1/images/edits"] },
				],
			},
		],
	});
	assert.deepEqual(models[0]?.capabilities, ["text", "image"]);
	assert.deepEqual(models[0]?.operations, [
		"text.generate",
		"image.generate",
		"image.edit",
	]);
	assert.deepEqual(
		capabilityGroups(models).flatMap((group) =>
			group.items.map((item) => item.key),
		),
		["text:public-model", "image:public-model"],
	);
});

test("a text model with no contract the gateway exposes is not offered at all", () => {
	assert.deepEqual(
		parsePublicModels({
			data: [
				{
					...model(),
					operations: [
						{ id: "text.generate", endpoints: ["/v1/chat/completions"] },
					],
					text_capabilities: {
						...model().text_capabilities,
						contracts: ["responses"],
					},
				},
			],
		}),
		[],
	);
});

test("service modes come from the catalog and unknown ones are ignored", () => {
	const [parsed] = parsePublicModels({
		data: [{ ...model(), service_modes: ["flex", "ultrafast", "fast"] }],
	});
	assert.deepEqual(parsed?.serviceModes, ["fast", "flex"]);
	const [plain] = parsePublicModels({ data: [model()] });
	assert.deepEqual(plain?.serviceModes, []);
});

test("reads what a video model accepts, and leaves it unknown when the gateway does not say", () => {
	const [omni, legacy] = parsePublicModels({
		data: [
			{
				id: "omni",
				operations: [{ id: "video.generate", endpoints: ["/v1/videos"] }],
				video_capabilities: {
					tasks: ["text_to_video", "edit"],
					durations: ["3", "10"],
					sizes: [
						{ size: "640x360", aspect_ratio: "16:9", resolution: "360p" },
					],
					qualities: [],
					seed: false,
					generate_audio: false,
					input_references: {
						image: true,
						video: true,
						audio: false,
						frame_images: true,
						max: 6,
					},
				},
			},
			{
				id: "video-old",
				operations: [{ id: "video.generate", endpoints: ["/v1/videos"] }],
			},
		],
	});
	assert.deepEqual(omni?.video, {
		tasks: ["text_to_video", "edit"],
		durations: [3, 10],
		sizes: [{ size: "640x360", aspectRatio: "16:9", resolution: "360p" }],
		qualities: [],
		seed: false,
		generateAudio: false,
		references: { image: true, video: true, frameImages: true },
	});
	assert.equal(legacy?.video, undefined);
});

test("reads what an image model accepts per operation", () => {
	const operation = {
		sizes: ["1024x1024"],
		arbitrary_sizes: true,
		qualities: ["low", "high"],
		output_formats: ["png"],
		transparent_background: true,
		style: false,
		mask: true,
		max_n: 10,
		max_input_images: 16,
	};
	const [image] = parsePublicModels({
		data: [
			{
				id: "gpt-image",
				operations: [
					{ id: "image.generate", endpoints: ["/v1/images/generations"] },
				],
				image_capabilities: { generate: operation },
			},
		],
	});
	assert.deepEqual(image?.image, {
		generate: {
			sizes: ["1024x1024"],
			arbitrarySizes: true,
			qualities: ["low", "high"],
			outputFormats: ["png"],
			transparentBackground: true,
			style: false,
			mask: true,
			maxN: 10,
			maxInputImages: 16,
		},
	});
});

test("reads what embedding and transcription models accept", () => {
	const [embed, whisper] = parsePublicModels({
		data: [
			{
				id: "embed",
				operations: [{ id: "embedding.create", endpoints: ["/v1/embeddings"] }],
				embedding_capabilities: {
					dimensions: { min: 256, max: 3072 },
					encoding_formats: ["float"],
					max_inputs: 2048,
				},
			},
			{
				id: "whisper",
				operations: [
					{ id: "audio.transcribe", endpoints: ["/v1/audio/transcriptions"] },
				],
				transcription_capabilities: {
					response_formats: ["json", "verbose_json"],
					timestamp_granularities: ["segment", "word"],
				},
			},
		],
	});
	assert.deepEqual(embed?.embedding, {
		dimensions: { min: 256, max: 3072 },
		encodingFormats: ["float"],
	});
	assert.deepEqual(whisper?.transcription, {
		responseFormats: ["json", "verbose_json"],
		timestampGranularities: ["segment", "word"],
	});
});
