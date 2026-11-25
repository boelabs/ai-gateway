import assert from "node:assert/strict";
import type { FetchLike } from "./api";
import { test } from "node:test";

import {
	type ImageSettings,
	withImageSetting,
	fitImageSettings,
	generationBody,
	imageChoices,
	imagesFrom,
	runImages,
	editForm,
} from "./images";

const settings: ImageSettings = {
	size: "1024x1536",
	quality: "high",
	n: 2,
	background: "transparent",
	outputFormat: "webp",
	outputCompression: 80,
	style: "vivid",
};

test("a parameter nobody chose is not sent at all", () => {
	assert.deepEqual(generationBody("gpt-image", "a fox", {}), {
		model: "gpt-image",
		prompt: "a fox",
		response_format: "b64_json",
		stream: false,
	});
});

test("chosen parameters are sent under the names the generation endpoint uses", () => {
	assert.deepEqual(generationBody("gpt-image", "a fox", settings), {
		model: "gpt-image",
		prompt: "a fox",
		size: "1024x1536",
		style: "vivid",
		quality: "high",
		n: 2,
		background: "transparent",
		output_format: "webp",
		output_compression: 80,
		response_format: "b64_json",
		stream: false,
	});
});

test("an edit carries its sources and drops the parameters that only shape a new image", () => {
	const file = new File([new Uint8Array([1, 2, 3])], "source.png", {
		type: "image/png",
	});
	const form = editForm("gpt-image", "make it snow", [file, file], settings);
	assert.equal(form.get("model"), "gpt-image");
	assert.equal(form.get("prompt"), "make it snow");
	assert.equal(form.getAll("image").length, 2);
	assert.equal(form.get("quality"), "high");
	assert.equal(form.get("output_compression"), "80");
	// The source decides the size, and DALL·E's `style` has no meaning for an edit.
	assert.equal(form.get("size"), null);
	assert.equal(form.get("style"), null);
});

test("images arrive as data URLs typed by the format the gateway reported", () => {
	assert.deepEqual(
		imagesFrom({
			data: [{ b64_json: "AAAA" }, { b64_json: "BBBB" }],
			output_format: "webp",
		}),
		[
			{ url: "data:image/webp;base64,AAAA", mediaType: "image/webp" },
			{ url: "data:image/webp;base64,BBBB", mediaType: "image/webp" },
		],
	);
	assert.deepEqual(imagesFrom({ data: [{ b64_json: "AAAA" }] }), [
		{ url: "data:image/png;base64,AAAA", mediaType: "image/png" },
	]);
	assert.deepEqual(imagesFrom({ data: [{}] }), []);
});

test("a prompt alone generates, and a prompt with sources edits", async () => {
	const calls: Array<{ url: string; multipart: boolean }> = [];
	const stub: FetchLike = async (input, init) => {
		calls.push({
			url: String(input),
			multipart: init?.body instanceof FormData,
		});
		return Response.json({ created: 1, data: [] });
	};
	const options = { fetch: stub, csrf: () => "token" };
	await runImages(
		{ model: "m", prompt: "a fox", files: [], settings: {} },
		options,
	);
	await runImages(
		{
			model: "m",
			prompt: "a fox",
			files: [new File(["x"], "a.png", { type: "image/png" })],
			settings: {},
		},
		options,
	);
	assert.deepEqual(calls, [
		{ url: "/api/v1/images/generations", multipart: false },
		{ url: "/api/v1/images/edits", multipart: true },
	]);
});

test("the gateway's own message survives a failure, instead of a bare status", async () => {
	const stub: FetchLike = async () =>
		new Response(
			JSON.stringify({ error: { message: "size is not supported" } }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	await assert.rejects(
		runImages(
			{ model: "m", prompt: "a fox", files: [], settings: {} },
			{ fetch: stub, csrf: () => undefined },
		),
		/size is not supported/u,
	);
});

const gemini = {
	sizes: ["1024x1024", "1344x768"],
	arbitrarySizes: false,
	aspectRatios: ["1:1", "16:9"],
	resolutions: ["1K", "2K"],
	qualities: ["low", "high"],
	outputFormats: ["png", "jpeg", "webp"],
	transparentBackground: false,
	style: false,
	mask: false,
	maxN: 1,
	maxInputImages: 14,
};

test("the image settings offer only what the model accepts", () => {
	const choices = imageChoices({ generate: gemini, edit: gemini }, true);
	assert.deepEqual(choices.sizes, ["auto", "1024x1024", "1344x768"]);
	assert.deepEqual(choices.qualities, ["auto", "low", "high"]);
	assert.deepEqual(choices.backgrounds, ["auto", "opaque"]);
	assert.deepEqual(choices.styles, []);
	assert.equal(choices.maxN, 1);
	assert.equal(choices.compression, true);
});

test("a model that also edits offers only what both operations accept", () => {
	const choices = imageChoices(
		{
			generate: { ...gemini, transparentBackground: true, maxN: 10 },
			edit: { ...gemini, qualities: ["high"], maxN: 4 },
		},
		true,
	);
	assert.deepEqual(choices.qualities, ["auto", "high"]);
	assert.deepEqual(choices.backgrounds, ["auto", "opaque"]);
	assert.equal(choices.maxN, 4);
});

test("aspect ratio and resolution are offered only as far as both operations take them", () => {
	const choices = imageChoices(
		{ generate: gemini, edit: { ...gemini, resolutions: ["1K"] } },
		true,
	);
	assert.deepEqual(choices.aspectRatios, ["1:1", "16:9"]);
	assert.deepEqual(choices.resolutions, ["1K"]);
});

test("a size and an aspect ratio or resolution never go out together", () => {
	const shaped = withImageSetting(
		withImageSetting(
			{ size: "1024x1024", quality: "low" },
			"aspectRatio",
			"16:9",
		),
		"resolution",
		"2K",
	);
	assert.deepEqual(shaped, {
		quality: "low",
		aspectRatio: "16:9",
		resolution: "2K",
	});
	assert.deepEqual(withImageSetting(shaped, "size", "1344x768"), {
		quality: "low",
		size: "1344x768",
	});
	assert.deepEqual(withImageSetting(shaped, "aspectRatio", undefined), {
		quality: "low",
		resolution: "2K",
	});
});

test("an edit sends the aspect ratio and resolution, unlike a size", () => {
	const file = new File([new Uint8Array([1, 2, 3])], "source.png", {
		type: "image/png",
	});
	const form = editForm("gemini", "make it snow", [file], { resolution: "2K" });
	assert.equal(form.get("resolution"), "2K");
	assert.equal(form.get("aspect_ratio"), null);
	assert.deepEqual(
		generationBody("gemini", "a fox", {
			aspectRatio: "16:9",
			resolution: "2K",
		}),
		{
			model: "gemini",
			prompt: "a fox",
			aspect_ratio: "16:9",
			resolution: "2K",
			response_format: "b64_json",
			stream: false,
		},
	);
});

test("without the model's options every image value is offered", () => {
	const choices = imageChoices(undefined, true);
	assert.deepEqual(choices.aspectRatios, []);
	assert.ok(choices.qualities.includes("hd"));
	assert.ok(choices.backgrounds.includes("transparent"));
	assert.equal(choices.maxN, 10);
});

test("switching image models drops the settings the new model would refuse", () => {
	assert.deepEqual(fitImageSettings(settings, { generate: gemini }, false), {
		quality: "high",
		outputFormat: "webp",
		outputCompression: 80,
	});
	assert.deepEqual(
		fitImageSettings(
			{ aspectRatio: "21:9", resolution: "2K" },
			{ generate: gemini },
			false,
		),
		{ resolution: "2K" },
	);
	const kept: ImageSettings = { size: "1344x768", quality: "low" };
	assert.equal(fitImageSettings(kept, { generate: gemini }, false), kept);
	assert.equal(fitImageSettings(settings, undefined, false), settings);
});
