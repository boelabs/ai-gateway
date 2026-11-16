import { speechRequestSchema, speechRequestToCanonical } from "./speech.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("speech request maps to canonical, taking a custom voice by id", () => {
	assert.deepEqual(
		speechRequestToCanonical(
			speechRequestSchema.parse({
				model: "tts",
				input: "Hello",
				voice: { id: "voice_123" },
				instructions: "cheerful",
				response_format: "wav",
				speed: 1,
			}),
		),
		{
			model: "tts",
			input: "Hello",
			voice: "voice_123",
			instructions: "cheerful",
			responseFormat: "wav",
			speed: 1,
		},
	);
});

test("speech request refuses SSE streaming and unknown fields", () => {
	assert.throws(
		() =>
			speechRequestToCanonical(
				speechRequestSchema.parse({
					model: "tts",
					input: "Hello",
					voice: "Kore",
					stream_format: "sse",
				}),
			),
		(error: unknown) =>
			error instanceof GatewayError && error.param === "stream_format",
	);
	assert.equal(
		speechRequestSchema.safeParse({
			model: "tts",
			input: "Hello",
			voice: "Kore",
			pitch: 2,
		}).success,
		false,
	);
});
