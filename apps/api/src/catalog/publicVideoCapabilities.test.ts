import { publicVideoCapabilities } from "./publicVideoCapabilities.ts";
import { resolveModelMetadata } from "./index.ts";
import type { CatalogEntry } from "./types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function resolve(entry: CatalogEntry) {
	return resolveModelMetadata("custom", "private-upstream", entry);
}

test("public video metadata lists only what the model accepts", () => {
	const meta = resolve({
		operations: {
			"video.generate": {
				transport: "interactions",
				tasks: ["text_to_video", "edit"],
				durations: ["10", "4", "8"],
				supportsImageUrl: true,
				supportsVideoUrl: true,
				maxInputReferences: 3,
				sizes: {
					"640x360": {
						aspectRatio: "16:9",
						resolution: "360p",
						outputTokensPerSecond: 1931,
					},
					"720x1280": { aspectRatio: "9:16", resolution: "720p" },
				},
			},
		},
	});
	assert.deepEqual(publicVideoCapabilities([meta]), {
		tasks: ["text_to_video", "edit"],
		durations: ["4", "8", "10"],
		sizes: [
			{ size: "640x360", aspect_ratio: "16:9", resolution: "360p" },
			{ size: "720x1280", aspect_ratio: "9:16", resolution: "720p" },
		],
		qualities: [],
		seed: false,
		generate_audio: false,
		input_references: {
			image: true,
			video: true,
			audio: false,
			frame_images: false,
			max: 3,
		},
	});
});

test("a pool lists only what every deployment accepts", () => {
	const first = resolve({
		operations: {
			"video.generate": {
				durations: ["4", "8"],
				supportsSeed: true,
				sizes: {
					"1280x720": { aspectRatio: "16:9", resolution: "720p" },
					"3840x2160": { aspectRatio: "16:9", resolution: "4k" },
				},
			},
		},
	});
	const second = resolve({
		operations: {
			"video.generate": {
				durations: ["8"],
				sizes: {
					"1280x720": { aspectRatio: "16:9", resolution: "720p" },
				},
			},
		},
	});
	const result = publicVideoCapabilities([first, second]);
	assert.deepEqual(result?.durations, ["8"]);
	assert.deepEqual(result?.sizes, [
		{ size: "1280x720", aspect_ratio: "16:9", resolution: "720p" },
	]);
	assert.equal(result?.seed, false);
});

test("models without video generation have no video metadata, and no size table leaves sizes out", () => {
	assert.equal(
		publicVideoCapabilities([resolve({ operations: { "text.generate": {} } })]),
		undefined,
	);
	const unbounded = publicVideoCapabilities([
		resolve({ operations: { "video.generate": { durations: ["5"] } } }),
	]);
	assert.ok(unbounded);
	assert.equal("sizes" in unbounded, false);
});
