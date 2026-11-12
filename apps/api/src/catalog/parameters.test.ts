import type { CanonicalChatRequest } from "#core/canonical.ts";
import type { ResolvedModelMetadata } from "./types.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyUnsupportedParameterPolicy,
	assertSupportedChatParameters,
	supportedParameterNames,
	withAdapterParameters,
} from "./parameters.ts";

const meta: ResolvedModelMetadata = {
	capabilities: {
		tools: false,
		vision: true,
		reasoning: true,
		structuredOutputs: false,
	},
	reasoning: { kind: "fixed", levels: ["medium"] },
	operations: {
		"text.generate": {
			parameters: {
				temperature: false,
				top_k: { mode: "unsupported" },
				verbosity: { mode: "ignored" },
				reasoning: true,
				stop: true,
			},
		},
	},
};

function request(): CanonicalChatRequest {
	return {
		callType: "chat",
		model: "public",
		messages: [{ role: "user", content: "hi" }],
		stream: false,
		temperature: 0.2,
		topP: 0.9,
		stop: ["done"],
		reasoning: { effort: "medium" },
		extraBody: {
			top_k: 40,
			repetition_penalty: 1.1,
		},
		responsesTransport: {
			text: { verbosity: "high" },
			topLogprobs: 3,
		},
	};
}

test("supportedParameterNames combines defaults, capabilities, and explicit overrides", () => {
	const names = supportedParameterNames(meta);
	assert.equal(names.includes("temperature"), false);
	assert.equal(names.includes("top_k"), false);
	assert.equal(names.includes("verbosity"), false);
	assert.equal(names.includes("tools"), false);
	assert.equal(names.includes("tool_choice"), false);
	assert.equal(names.includes("reasoning"), true);
	assert.equal(names.includes("stop"), true);
});

test("drop policy removes only explicitly unsupported parameters", () => {
	const result = applyUnsupportedParameterPolicy(request(), meta, "drop");
	assert.deepEqual(result.droppedParameters, [
		"temperature",
		"top_k",
		"verbosity",
	]);
	assert.equal(result.request.temperature, undefined);
	assert.equal(result.request.topP, 0.9);
	assert.deepEqual(result.request.extraBody, { repetition_penalty: 1.1 });
	assert.deepEqual(result.request.responsesTransport, { topLogprobs: 3 });
});

test("error policy raises a public bad_request", () => {
	assert.throws(
		() => assertSupportedChatParameters(request(), meta),
		(error) =>
			GatewayError.is(error) &&
			error.class === "bad_request" &&
			error.code === "unsupported_parameter",
	);
});

test("allow policy leaves unsupported parameters untouched", () => {
	const req = request();
	const result = applyUnsupportedParameterPolicy(req, meta, "allow");
	assert.equal(result.request, req);
	assert.deepEqual(result.unsupportedParameters, [
		"temperature",
		"top_k",
		"verbosity",
	]);
	assert.deepEqual(result.droppedParameters, []);
});

test("prompt-cache policies participate in explicit model parameter support", () => {
	const req: CanonicalChatRequest = {
		...request(),
		promptCachePolicy: { mode: "explicit" },
		promptCacheRetention: "extended",
		messagesTransport: { cacheControl: { type: "ephemeral" } },
	};
	const metadata: ResolvedModelMetadata = {
		capabilities: meta.capabilities,
		operations: {
			"text.generate": {
				parameters: {
					prompt_cache_options: false,
					prompt_cache_retention: false,
					cache_control: false,
				},
			},
		},
	};
	assert.throws(
		() => applyUnsupportedParameterPolicy(req, metadata, "error"),
		/does not support/u,
	);
	const dropped = applyUnsupportedParameterPolicy(req, metadata, "drop");
	assert.deepEqual(dropped.droppedParameters, [
		"cache_control",
		"prompt_cache_options",
		"prompt_cache_retention",
	]);
	assert.equal(dropped.request.promptCachePolicy, undefined);
	assert.equal(dropped.request.promptCacheRetention, undefined);
	assert.equal(dropped.request.messagesTransport, undefined);
	assert.deepEqual(
		applyUnsupportedParameterPolicy(req, metadata, "allow").request,
		req,
	);
});

test("an adapter's declaration drops what its transport cannot carry", () => {
	const adapterParameters = {
		seed: { mode: "unsupported" as const },
		stop: { mode: "unsupported" as const },
		temperature: { mode: "supported" as const },
	};
	const view = withAdapterParameters(meta, adapterParameters);
	const req: CanonicalChatRequest = { ...request(), seed: 7 };
	const result = applyUnsupportedParameterPolicy(req, view, "drop");
	assert.equal(result.request.seed, undefined);
	// The model accepts stop, but a transport with no field for it cannot carry it there.
	assert.equal(result.request.stop, undefined);
	for (const name of ["seed", "stop", "temperature"]) {
		assert.ok(result.droppedParameters.includes(name), name);
	}
	// What the model rejects stays rejected whatever the transport could carry.
	assert.equal(result.request.temperature, undefined);
	// The merged map is stable, so per-map caches stay effective.
	assert.equal(
		withAdapterParameters(meta, adapterParameters).operations?.["text.generate"]
			?.parameters,
		view.operations?.["text.generate"]?.parameters,
	);
	assert.equal(withAdapterParameters(meta, undefined), meta);
});
