import {
	liveDelegatedModels,
	liveDelegationType,
	LiveUsageMeter,
} from "./live.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("live: delegation type defaults to client, and both backend models are found", () => {
	assert.equal(liveDelegationType({}), "client");
	assert.equal(liveDelegationType({ delegation: null }), "client");
	const session = {
		delegation: {
			type: "responses",
			responses: { model: "gpt-6-luna" },
			decisions: { model: "gpt-6-luna-decide" },
		},
	};
	assert.equal(liveDelegationType(session), "responses");
	assert.deepEqual(liveDelegatedModels(session), [
		"gpt-6-luna",
		"gpt-6-luna-decide",
	]);
});

test("live: session seconds are cumulative and replaced, never summed", () => {
	const meter = new LiveUsageMeter(undefined);
	assert.equal(
		meter.observe({ type: "session.usage.updated", usage: { seconds: 10 } }),
		true,
	);
	assert.equal(
		meter.observe({ type: "session.usage.updated", usage: { seconds: 25 } }),
		true,
	);
	assert.equal(
		meter.observe({ type: "session.usage.updated", usage: { seconds: 25 } }),
		false,
	);
	assert.equal(meter.seconds, 25);
	meter.observe({ type: "session.closed", usage: { seconds: 31 } });
	assert.equal(meter.seconds, 31);
	assert.equal(meter.closed, true);
});

test("live: each backend response and decision is counted once, against its model", () => {
	const meter = new LiveUsageMeter("gpt-6-luna");
	const completed = {
		type: "response.event",
		event_id: "event_1",
		event: {
			type: "response.completed",
			response: {
				id: "resp_1",
				service_tier: "flex",
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					input_tokens_details: { cached_tokens: 40 },
					output_tokens_details: { reasoning_tokens: 5 },
				},
			},
		},
	};
	assert.equal(meter.observe(completed), true);
	assert.equal(meter.observe(completed), false);
	assert.equal(
		meter.observe({
			type: "response.event",
			event: { type: "response.output_text.delta", delta: "hi" },
		}),
		false,
	);
	meter.delegateTo("gpt-6-sol");
	meter.observe({
		type: "response.event",
		event: {
			type: "response.completed",
			response: { id: "resp_2", usage: { input_tokens: 1, output_tokens: 1 } },
		},
	});
	meter.observe({
		type: "decision.event",
		event_id: "event_9",
		event: {
			type: "decision.completed",
			decision: {
				model: "gpt-6-luna",
				usage: { input_tokens: 7, output_tokens: 1 },
			},
		},
	});
	assert.deepEqual(meter.delegated, [
		{
			model: "gpt-6-luna",
			usage: {
				promptTokens: 100,
				completionTokens: 20,
				totalTokens: 120,
				cacheReadTokens: 40,
				reasoningTokens: 5,
				serviceTier: "flex",
			},
		},
		{
			model: "gpt-6-sol",
			usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		},
		{
			model: "gpt-6-luna",
			usage: { promptTokens: 7, completionTokens: 1, totalTokens: 8 },
		},
	]);
});
