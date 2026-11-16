import { pcmToWav, speechFormatFor, readWav } from "./speech.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("pcmToWav writes a 44-byte mono 16-bit header that readWav reads back", () => {
	const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
	const wav = pcmToWav(pcm, 24_000);
	assert.equal(wav.byteLength, 50);
	assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
	const view = new DataView(wav.buffer);
	assert.equal(readWav(wav)?.sampleRate, 24_000);
	assert.equal(view.getUint32(28, true), 48_000);
	assert.equal(view.getUint32(40, true), 6);
	assert.deepEqual(readWav(wav)?.pcm, pcm);
});

test("readWav finds the data chunk after extra chunks and rejects non-WAV bytes", () => {
	const wav = pcmToWav(new Uint8Array([9, 9]), 16_000);
	// A LIST chunk between fmt and data, as some encoders write.
	const list = new Uint8Array([
		...new TextEncoder().encode("LIST"),
		4,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
	]);
	const withList = new Uint8Array([
		...wav.subarray(0, 36),
		...list,
		...wav.subarray(36),
	]);
	assert.deepEqual(readWav(withList)?.pcm, new Uint8Array([9, 9]));
	assert.equal(readWav(new Uint8Array([1, 2, 3])), null);
});

test("speechFormatFor falls back to the profile's first format", () => {
	assert.equal(speechFormatFor({}, { responseFormats: ["wav", "pcm"] }), "wav");
	assert.equal(
		speechFormatFor(
			{ responseFormat: "pcm" },
			{ responseFormats: ["wav", "pcm"] },
		),
		"pcm",
	);
});
