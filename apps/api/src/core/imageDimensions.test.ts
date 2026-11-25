import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type CanonicalImageRequest,
	type ImageModelProfile,
	withResolvedDimensions,
	imageDimensionOptions,
	normalizeAspectRatio,
	matchImageDimensions,
	resolveImageSize,
} from "./images.ts";

/** Gemini-style: every entry maps to a native ratio and tier, and the model picks a ratio itself. */
const gemini: ImageModelProfile = {
	autoSize: {},
	sizes: {
		"1024x1024": { aspectRatio: "1:1", imageSize: "1K" },
		"2048x2048": { aspectRatio: "1:1", imageSize: "2K" },
		"1376x768": { aspectRatio: "16:9", imageSize: "1K" },
		"2752x1536": { aspectRatio: "16:9", imageSize: "2K" },
	},
};

/** gpt-image-style: exact sizes with no native mapping and no tiers. */
const exact: ImageModelProfile = {
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

const base: CanonicalImageRequest = {
	operation: "generation",
	model: "image",
	prompt: "p",
	stream: false,
};

test("aspect ratios compare in lowest terms", () => {
	assert.equal(normalizeAspectRatio("32:18"), "16:9");
	assert.equal(normalizeAspectRatio("1:1"), "1:1");
	assert.equal(normalizeAspectRatio("0:1"), undefined);
	assert.equal(normalizeAspectRatio("wide"), undefined);
});

test("a ratio alone takes the first entry in table order, so the model's default tier", () => {
	assert.deepEqual(matchImageDimensions({ aspectRatio: "16:9" }, gemini), {
		size: "1376x768",
	});
	assert.deepEqual(
		matchImageDimensions({ aspectRatio: "16:9", resolution: "2K" }, gemini),
		{ size: "2752x1536" },
	);
	assert.deepEqual(matchImageDimensions({ aspectRatio: "32:18" }, gemini), {
		size: "1376x768",
	});
});

test("a ratio alone takes the default 1K tier even when a smaller one is listed first", () => {
	const flash: ImageModelProfile = {
		sizes: {
			"512x512": { aspectRatio: "1:1", imageSize: "512" },
			"1024x1024": { aspectRatio: "1:1", imageSize: "1K" },
			"2048x2048": { aspectRatio: "1:1", imageSize: "2K" },
			"2752x1536": { aspectRatio: "16:9", imageSize: "2K" },
		},
	};
	assert.deepEqual(matchImageDimensions({ aspectRatio: "1:1" }, flash), {
		size: "1024x1024",
	});
	assert.deepEqual(
		matchImageDimensions({ aspectRatio: "1:1", resolution: "512" }, flash),
		{ size: "512x512" },
	);
	// No 1K entry for the ratio: table order decides.
	assert.deepEqual(matchImageDimensions({ aspectRatio: "16:9" }, flash), {
		size: "2752x1536",
	});
});

test("exact-size entries match by their own dimensions and never get a guessed tier", () => {
	assert.deepEqual(matchImageDimensions({ aspectRatio: "2:3" }, exact), {
		size: "1024x1536",
	});
	assert.deepEqual(matchImageDimensions({ aspectRatio: "3:2" }, exact), {
		size: "1536x1024",
	});
	// 16:9 fits arbitrarySize, but nothing is computed from it.
	assert.equal(matchImageDimensions({ aspectRatio: "16:9" }, exact), undefined);
	assert.equal(matchImageDimensions({ resolution: "2K" }, exact), undefined);
});

test("a tier alone keeps the ratio automatic only where the model picks it natively", () => {
	assert.deepEqual(matchImageDimensions({ resolution: "2K" }, gemini), {
		size: "auto",
		resolution: "2K",
	});
	assert.equal(matchImageDimensions({ resolution: "4K" }, gemini), undefined);
	const { autoSize: _, ...noAuto } = gemini;
	assert.deepEqual(matchImageDimensions({ resolution: "2K" }, noAuto), {
		size: "2048x2048",
	});
});

test("the resolved request carries a size the transports already understand", () => {
	const ratio = withResolvedDimensions(
		{ ...base, aspectRatio: "16:9", resolution: "2K" },
		gemini,
	);
	assert.equal(ratio.size, "2752x1536");
	assert.equal("aspectRatio" in ratio, false);
	assert.equal("resolution" in ratio, false);
	assert.deepEqual(resolveImageSize(ratio, gemini), {
		size: "2752x1536",
		aspectRatio: "16:9",
		imageSize: "2K",
	});

	const tierOnly = withResolvedDimensions(
		{ ...base, resolution: "2K" },
		gemini,
	);
	assert.equal(tierOnly.size, "auto");
	assert.deepEqual(resolveImageSize(tierOnly, gemini), {
		size: "auto",
		imageSize: "2K",
	});

	const untouched = { ...base, size: "1024x1024" };
	assert.equal(withResolvedDimensions(untouched, gemini), untouched);
});

test("a model's options list each ratio and tier once, in table order", () => {
	assert.deepEqual(imageDimensionOptions(gemini), {
		aspectRatios: ["1:1", "16:9"],
		resolutions: ["1K", "2K"],
	});
	assert.deepEqual(imageDimensionOptions(exact), {
		aspectRatios: ["1:1", "3:2", "2:3"],
		resolutions: [],
	});
	assert.deepEqual(imageDimensionOptions(undefined), {
		aspectRatios: [],
		resolutions: [],
	});
});
