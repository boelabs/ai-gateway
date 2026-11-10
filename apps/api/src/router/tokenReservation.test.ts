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
