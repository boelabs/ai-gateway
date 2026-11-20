import { publicEmbeddingCapabilities } from "./publicEmbeddingCapabilities.ts";
import { resolveModelMetadata } from "./index.ts";
import type { CatalogEntry } from "./types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function resolve(entry: CatalogEntry) {
	return resolveModelMetadata("custom", "private-upstream", entry);
}

test("public embedding metadata gives the dimension range only when vectors can be shortened", () => {
	const shortening = resolve({
		operations: {
			"embedding.create": {
				dimensions: 3072,
				supportsDimensions: true,
				minDimensions: 256,
				maxInputs: 2048,
			},
		},
	});
	assert.deepEqual(publicEmbeddingCapabilities([shortening]), {
		dimensions: { min: 256, max: 3072 },
		encoding_formats: ["float", "base64"],
		max_inputs: 2048,
	});
	const fixed = resolve({
		operations: {
			"embedding.create": { dimensions: 1536, encodingFormats: ["float"] },
		},
	});
	assert.deepEqual(publicEmbeddingCapabilities([fixed]), {
		encoding_formats: ["float"],
	});
});

test("a pool lists only what every embedding deployment accepts", () => {
	const wide = resolve({
		operations: {
			"embedding.create": { dimensions: 3072, supportsDimensions: true },
		},
	});
	const narrow = resolve({
		operations: {
			"embedding.create": {
				dimensions: 1024,
				supportsDimensions: true,
				minDimensions: 64,
			},
		},
	});
	assert.deepEqual(publicEmbeddingCapabilities([wide, narrow])?.dimensions, {
		min: 64,
		max: 1024,
	});
	assert.equal(
		publicEmbeddingCapabilities([
			resolve({ operations: { "text.generate": {} } }),
		]),
		undefined,
	);
});
