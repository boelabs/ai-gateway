import assert from "node:assert/strict";
import { test } from "node:test";

import {
	estimateTokenReservation,
	estimateUnreportedUsage,
	reservedTotal,
} from "./tokenReservation.ts";

test("token reservation conservatively combines UTF-8 input and output bounds", () => {
	const payload = { input: "é" };
	const reservation = estimateTokenReservation(payload, {
		maxOutputTokens: 10,
		additionalInputTokens: 20,
	});
	assert.deepEqual(reservation, {
		inputTokens: Buffer.byteLength(JSON.stringify(payload), "utf8") + 20,
		outputTokens: 10,
	});
	assert.equal(
		reservedTotal(reservation),
		Buffer.byteLength(JSON.stringify(payload), "utf8") + 30,
	);
});

test("token reservation ignores invalid optional bounds", () => {
	assert.equal(
		reservedTotal(estimateTokenReservation(null, { maxOutputTokens: -1 })),
		4,
	);
});

test("unreported usage settles the reserved input plus the observed output", () => {
	const usage = estimateUnreportedUsage(
		{ inputTokens: 120, outputTokens: 4096 },
		35,
	);
	assert.deepEqual(usage, {
		promptTokens: 120,
		completionTokens: 35,
		totalTokens: 155,
		estimated: true,
	});
});

test("unreported usage never goes below what the adapter could report", () => {
	const usage = estimateUnreportedUsage(
		{ inputTokens: 10, outputTokens: 100 },
		5,
		{
			promptTokens: 40,
			completionTokens: 20,
			totalTokens: 60,
			estimated: true,
		},
	);
	assert.equal(usage.promptTokens, 40);
	assert.equal(usage.completionTokens, 20);
	assert.equal(usage.totalTokens, 60);
	assert.equal(usage.estimated, true);
});

test("inline media reserves its modality bound, not its base64 characters", () => {
	const image = `data:image/png;base64,${Buffer.alloc(300_000).toString("base64")}`;
	const reservation = estimateTokenReservation({
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe" },
					{ type: "image", url: image },
				],
			},
		],
	});
	assert.ok(reservation.inputTokens >= 2500, String(reservation.inputTokens));
	assert.ok(reservation.inputTokens < 3000, String(reservation.inputTokens));
});

test("inline audio and PDFs reserve by duration and pages", () => {
	const audio = estimateTokenReservation({
		type: "audio",
		data: Buffer.alloc(320_000).toString("base64"),
		format: "wav",
	});
	// Ten seconds of 16 kHz PCM: about 320 tokens, not 427,000 base64 characters.
	assert.ok(audio.inputTokens < 1000, String(audio.inputTokens));
	const pdf = estimateTokenReservation({
		fileData: `data:application/pdf;base64,${Buffer.from("/Type /Page /Type /Page", "latin1").toString("base64")}`,
	});
	assert.ok(pdf.inputTokens >= 2 * 5500, String(pdf.inputTokens));
});
