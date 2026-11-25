import { publicImageCapabilities } from "./publicImageCapabilities.ts";
import type { ImageModelProfile } from "#core/images.ts";
import { resolveModelMetadata } from "./index.ts";
import type { CatalogEntry } from "./types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function resolve(entry: CatalogEntry) {
	return resolveModelMetadata("custom", "private-upstream", entry);
}

const gptImage: ImageModelProfile = {
	maxN: 10,
	maxInputImages: 16,
	supportsMask: true,
	supportsTransparentBackground: true,
	outputFormats: ["png", "jpeg", "webp"],
	qualities: ["low", "medium", "high"],
	autoSize: {},
	sizes: { "1024x1024": {}, "1536x1024": {}, "1024x1536": {} },
	arbitrarySize: {
		divisibleBy: 16,
		minAspectRatio: 1 / 3,
		maxAspectRatio: 3,
		maxWidth: 3840,
		maxHeight: 3840,
	},
};

test("public image metadata lists what each operation accepts", () => {
	const meta = resolve({
		operations: {
			"image.generate": { ...gptImage, supportsStyle: false },
			"image.edit": gptImage,
		},
	});
	const result = publicImageCapabilities([meta]);
	assert.deepEqual(result?.generate, {
		sizes: ["1024x1024", "1536x1024", "1024x1536"],
		arbitrary_sizes: true,
		aspect_ratios: ["1:1", "3:2", "2:3"],
		resolutions: [],
		qualities: ["low", "medium", "high"],
		output_formats: ["png", "jpeg", "webp"],
		transparent_background: true,
		style: false,
		mask: true,
		max_n: 10,
		max_input_images: 16,
	});
	assert.ok(result?.edit);
});

test("a pool lists only what every deployment accepts", () => {
	const first = resolve({ operations: { "image.generate": gptImage } });
	const second = resolve({
		operations: {
			"image.generate": {
				maxN: 1,
				outputFormats: ["png"],
				qualities: ["low", "high"],
				sizes: { "1024x1024": { aspectRatio: "1:1", imageSize: "1K" } },
			},
		},
	});
	const result = publicImageCapabilities([first, second]);
	assert.deepEqual(result?.generate?.sizes, ["1024x1024"]);
	assert.deepEqual(result?.generate?.aspect_ratios, ["1:1"]);
	// Only the second deployment declares tiers, so the pool promises none.
	assert.deepEqual(result?.generate?.resolutions, []);
	assert.deepEqual(result?.generate?.qualities, ["low", "high"]);
	assert.deepEqual(result?.generate?.output_formats, ["png"]);
	assert.equal(result?.generate?.max_n, 1);
	assert.equal(result?.generate?.transparent_background, false);
	assert.equal(result?.generate?.arbitrary_sizes, false);
	assert.equal(result?.edit, undefined);
});

test("a pool agrees on a ratio however each deployment spells it", () => {
	const native = resolve({
		operations: {
			"image.generate": {
				sizes: { "1584x672": { aspectRatio: "21:9", imageSize: "1K" } },
			},
		},
	});
	const exact = resolve({
		operations: { "image.generate": { sizes: { "2016x864": {} } } },
	});
	assert.deepEqual(
		publicImageCapabilities([native, exact])?.generate?.aspect_ratios,
		["21:9"],
	);
});

test("models without image operations have no image metadata", () => {
	assert.equal(
		publicImageCapabilities([resolve({ operations: { "text.generate": {} } })]),
		undefined,
	);
});
