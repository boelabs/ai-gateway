import { imageUsageToCore, imageResponseUsage } from "./images.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("an image endpoint's unsplit output is image output", () => {
	assert.deepEqual(
		imageUsageToCore({
			inputTokens: 20,
			outputTokens: 1120,
			totalTokens: 1140,
		}),
		{
			promptTokens: 20,
			completionTokens: 1120,
			totalTokens: 1140,
			completionImageTokens: 1120,
		},
	);
});

test("an upstream's modality split is kept", () => {
	assert.deepEqual(
		imageUsageToCore({
			inputTokens: 300,
			outputTokens: 1200,
			totalTokens: 1500,
			inputImageTokens: 258,
			outputTextTokens: 80,
		}),
		{
			promptTokens: 300,
			completionTokens: 1200,
			totalTokens: 1500,
			promptImageTokens: 258,
			completionImageTokens: 1120,
		},
	);
	assert.equal(imageUsageToCore(undefined), null);
});

test("image usage carries the generated images for per-image pricing", () => {
	assert.deepEqual(
		imageResponseUsage(undefined, {
			images: 2,
			size: "1024x1024",
			quality: "high",
		}),
		{
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			estimated: true,
			outputImages: 2,
			outputImageSize: "1024x1024",
			outputImageQuality: "high",
		},
	);
});

test("reported image tokens are kept beside the image count", () => {
	const usage = imageResponseUsage(
		{ inputTokens: 10, outputTokens: 100, totalTokens: 110 },
		{ images: 1 },
	);
	assert.equal(usage?.totalTokens, 110);
	assert.equal(usage?.outputImages, 1);
	assert.equal(usage?.estimated, undefined);
});
