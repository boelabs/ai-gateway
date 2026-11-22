import { candidateParameterMeta } from "#endpoints/runtime/parameterPolicy.ts";
import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import { applyUnsupportedParameterPolicy } from "#catalog/parameters.ts";
import type { CanonicalChatRequest } from "#core/canonical.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { anthropicAdapter } from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

function candidate(model: string): DeploymentCandidate {
	return {
		row: {} as DeploymentCandidate["row"],
		adapter: anthropicAdapter,
		upstreamModel: model,
		meta: resolveModelMetadata("anthropic", model),
	};
}

const BASE: CanonicalChatRequest = {
	callType: "chat",
	model: "claude",
	stream: false,
	messages: [{ role: "user", content: "hi" }],
	tools: [{ name: "lookup", parameters: { type: "object" } }],
};

function dropped(model: string, req: Partial<CanonicalChatRequest>) {
	const request = { ...BASE, ...req };
	return applyUnsupportedParameterPolicy(
		request,
		candidateParameterMeta(candidate(model), "messages", request),
		"drop",
	);
}

test("budget thinking drops sampling it conflicts with and forced tool use", () => {
	const result = dropped("claude-sonnet-4-5", {
		reasoning: { effort: "high" },
		temperature: 0.5,
		topK: 5,
		topP: 0.5,
		toolChoice: "required",
	});
	assert.deepEqual(result.droppedParameters, [
		"temperature",
		"tool_choice",
		"top_k",
		"top_p",
	]);
	assert.equal(result.request.temperature, undefined);
	assert.equal(result.request.toolChoice, undefined);
});

test("without thinking the same sampling parameters reach Anthropic", () => {
	const result = dropped("claude-sonnet-4-5", {
		reasoning: { effort: "none" },
		temperature: 0.5,
		topK: 5,
		toolChoice: "required",
	});
	assert.deepEqual(result.droppedParameters, []);
});

test("top_p inside 0.95-1 is kept while thinking is on", () => {
	const result = dropped("claude-sonnet-4-5", {
		reasoning: { effort: "high" },
		topP: 0.97,
	});
	assert.deepEqual(result.droppedParameters, []);
	assert.equal(result.request.topP, 0.97);
});

test("adaptive thinking keeps forced tool use where the model accepts it", () => {
	const result = dropped("claude-sonnet-4-6", {
		reasoning: { effort: "high" },
		temperature: 0.5,
		toolChoice: { name: "lookup" },
	});
	assert.deepEqual(result.droppedParameters, ["temperature"]);
	assert.deepEqual(result.request.toolChoice, { name: "lookup" });
});

test("models that reject sampling and forced tool use on every request say so", () => {
	const forced = dropped("claude-opus-5-5", {
		temperature: 0.5,
		toolChoice: "required",
	});
	assert.deepEqual(forced.droppedParameters, ["temperature", "tool_choice"]);
	const auto = dropped("claude-opus-5-5", { toolChoice: "auto" });
	assert.deepEqual(auto.droppedParameters, []);
	assert.equal(auto.request.toolChoice, "auto");
});
