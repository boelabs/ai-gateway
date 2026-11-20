import { publicTranscriptionCapabilities } from "./publicTranscriptionCapabilities.ts";
import { resolveModelMetadata } from "./index.ts";
import type { CatalogEntry } from "./types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function resolve(entry: CatalogEntry) {
	return resolveModelMetadata("custom", "private-upstream", entry);
}

test("public transcription metadata lists formats and timestamps every deployment accepts", () => {
	const whisper = resolve({
		operations: {
			"audio.transcribe": {
				responseFormats: ["json", "text", "srt", "verbose_json", "vtt"],
				supportsTimestampGranularities: true,
			},
		},
	});
	assert.deepEqual(publicTranscriptionCapabilities([whisper]), {
		response_formats: ["json", "text", "srt", "verbose_json", "vtt"],
		timestamp_granularities: ["segment", "word"],
	});
	const plain = resolve({
		operations: {
			"audio.transcribe": { responseFormats: ["json", "text"] },
		},
	});
	assert.deepEqual(publicTranscriptionCapabilities([whisper, plain]), {
		response_formats: ["json", "text"],
		timestamp_granularities: [],
	});
	assert.equal(
		publicTranscriptionCapabilities([
			resolve({ operations: { "text.generate": {} } }),
		]),
		undefined,
	);
});
