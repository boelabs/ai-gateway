import { preferredChatTransport } from "#endpoints/runtime/parameterPolicy.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { declaredTransportFor } from "#catalog/types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const BASE: CanonicalChatRequest = {
	callType: "chat",
	model: "m",
	stream: false,
	messages: [{ role: "user", content: "hi" }],
};

test("OpenAI models declare the text API they answer on, as OpenAI documents", () => {
	const declared = (model: string) =>
		declaredTransportFor(
			resolveModelMetadata("openai", model),
			"text.generate",
		);
	for (const model of [
		"gpt-5-pro",
		"gpt-5.1-codex",
		"o3-pro",
		"gpt-oss-120b",
	]) {
		assert.equal(declared(model), "responses", model);
	}
	for (const model of ["gpt-audio", "gpt-4o-search-preview"]) {
		assert.equal(declared(model), "chat_completions", model);
	}
	// Models that answer on both leave the choice to the request.
	assert.equal(declared("gpt-5.4"), undefined);
});

test("Chat-only controls prefer Chat Completions", () => {
	assert.equal(preferredChatTransport(BASE), undefined);
	for (const fields of [{ n: 2 }, { stop: ["x"] }, { seed: 1 }]) {
		assert.equal(
			preferredChatTransport({ ...BASE, ...fields }),
			"chat_completions",
		);
	}
	assert.equal(
		preferredChatTransport({
			...BASE,
			publicWire: "responses",
			requiresNativeWire: true,
		}),
		"responses",
	);
});
