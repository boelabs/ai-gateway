import { assertSpeechRequestSupported } from "./speechRequestValidation.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import type { CanonicalSpeechRequest } from "#core/speech.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const meta = {
	capabilities: {
		tools: false,
		vision: false,
		reasoning: false,
		structuredOutputs: false,
	},
	operations: {
		"audio.speech": {
			responseFormats: ["wav", "pcm"],
			supportsInstructions: true,
			maxInputCharacters: 10,
		},
	},
} satisfies ResolvedModelMetadata;

const req: CanonicalSpeechRequest = {
	model: "tts",
	input: "Hi",
	voice: "Kore",
};

function refusedParam(
	change: Partial<CanonicalSpeechRequest>,
): string | null | undefined {
	try {
		assertSpeechRequestSupported({ ...req, ...change }, meta);
	} catch (error) {
		assert.ok(error instanceof GatewayError);
		assert.equal(error.httpStatus, 400);
		return error.param;
	}
}

test("speech validation accepts what the profile offers", () => {
	assert.equal(refusedParam({}), undefined);
	assert.equal(refusedParam({ responseFormat: "pcm" }), undefined);
	assert.equal(refusedParam({ instructions: "calm" }), undefined);
	assert.equal(refusedParam({ speed: 1 }), undefined);
});

test("speech validation refuses formats, speeds and lengths the model cannot honor", () => {
	assert.equal(refusedParam({ responseFormat: "mp3" }), "response_format");
	assert.equal(refusedParam({ speed: 1.5 }), "speed");
	assert.equal(refusedParam({ input: "x".repeat(11) }), "input");
});
