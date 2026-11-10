import { googleInteractionCoreUsage } from "#adapters/google/index.ts";
import { videoOutputTokenBound } from "#core/videos.ts";
import { reservedBilling } from "./billing.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const profile = {
	durations: ["3", "5", "10"],
	sizes: {
		"640x360": { resolution: "360p", outputTokensPerSecond: 1931 },
		"1280x720": { resolution: "720p", outputTokensPerSecond: 5792 },
	},
};

test("the output bound uses the requested size and seconds", () => {
	assert.equal(
		videoOutputTokenBound(profile, { size: "640x360", seconds: "5" }),
		1931 * 5,
	);
});

test("the output bound assumes the densest size and the longest duration when unspecified", () => {
	assert.equal(videoOutputTokenBound(profile, {}), 5792 * 10);
});

test("the output bound is undefined without declared rates", () => {
	assert.equal(videoOutputTokenBound({ durations: ["5"] }, {}), undefined);
	assert.equal(videoOutputTokenBound(undefined, { seconds: "5" }), undefined);
});

test("Interactions usage maps video modality tokens and thoughts", () => {
	const usage = googleInteractionCoreUsage({
		total_input_tokens: 40,
		total_output_tokens: 5792,
		total_thought_tokens: 10,
		total_cached_tokens: 0,
		output_tokens_by_modality: [
			{ modality: "video", tokens: 5700 },
			{ modality: "text", tokens: 92 },
		],
	});
	assert.deepEqual(usage, {
		promptTokens: 40,
		completionTokens: 5802,
		totalTokens: 5842,
		reasoningTokens: 10,
		completionVideoTokens: 5700,
	});
});

test("Interactions usage without a modality breakdown bills every output token as video", () => {
	const usage = googleInteractionCoreUsage({
		total_input_tokens: 7,
		total_output_tokens: 1931,
	});
	assert.equal(usage?.completionVideoTokens, 1931);
	assert.equal(usage?.totalTokens, 1938);
});

test("Interactions usage without output tokens is not billable", () => {
	assert.equal(googleInteractionCoreUsage({ total_tokens: 3 }), undefined);
});

test("only a lease that holds counters becomes a billing record", () => {
	assert.equal(reservedBilling(null), null);
	const empty = { keyId: "k", tpmFirst: false, counters: [] };
	assert.equal(
		reservedBilling({
			charge: async () => ({ budgetExhausted: false }),
			settle: async () => undefined,
			release: async () => undefined,
			snapshot: () => empty,
		}),
		null,
	);
	const held = { keyId: "k", tpmFirst: false, counters: [{ id: "x" }] };
	const billing = reservedBilling({
		charge: async () => ({ budgetExhausted: false }),
		settle: async () => undefined,
		release: async () => undefined,
		snapshot: () => held as never,
	});
	assert.equal(billing?.state, "reserved");
});

test("a real Omni 1.2 usage payload (3s at 360p) maps to its billed tokens", () => {
	const usage = googleInteractionCoreUsage({
		total_tokens: 6297,
		total_input_tokens: 14,
		input_tokens_by_modality: [{ modality: "text", tokens: 14 }],
		total_cached_tokens: 0,
		total_output_tokens: 5793,
		output_tokens_by_modality: [{ modality: "video", tokens: 5793 }],
		total_tool_use_tokens: 0,
		total_thought_tokens: 490,
		initial_input_tokens: 30,
	});
	assert.deepEqual(usage, {
		promptTokens: 14,
		completionTokens: 6283,
		totalTokens: 6297,
		reasoningTokens: 490,
		completionVideoTokens: 5793,
	});
	// 3 seconds at 1,931 tokens per second of 360p video.
	assert.equal(5793, 3 * 1931);
});
