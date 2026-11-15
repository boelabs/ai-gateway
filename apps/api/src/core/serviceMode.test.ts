import assert from "node:assert/strict";
import { test } from "node:test";

import {
	assertServiceTierAgrees,
	parseServiceMode,
	supportsServiceMode,
} from "./serviceMode.ts";

test("only a known mode is split off the model slug", () => {
	assert.deepEqual(parseServiceMode("gpt-6.1-sol:flex"), {
		publicModel: "gpt-6.1-sol",
		serviceMode: "flex",
	});
	assert.deepEqual(parseServiceMode("claude-opus-5-5:fast"), {
		publicModel: "claude-opus-5-5",
		serviceMode: "fast",
	});
	// A colon that is not a mode belongs to the model's own name.
	assert.deepEqual(parseServiceMode("org:model"), { publicModel: "org:model" });
	assert.deepEqual(parseServiceMode("model:free"), {
		publicModel: "model:free",
	});
	assert.deepEqual(parseServiceMode(":fast"), { publicModel: ":fast" });
	assert.deepEqual(parseServiceMode("plain"), { publicModel: "plain" });
});

test("a mode needs both the adapter and a priced tier", () => {
	const priced = {
		pricing: { serviceTiers: { fast: { inputCentsPerMTokens: 1 } } },
	};
	assert.equal(supportsServiceMode(priced, new Set(["fast"]), "fast"), true);
	assert.equal(supportsServiceMode(priced, new Set(["flex"]), "fast"), false);
	assert.equal(supportsServiceMode(priced, undefined, "fast"), false);
	assert.equal(supportsServiceMode({}, new Set(["fast"]), "fast"), false);
});

test("an explicit service_tier must agree with the slug's mode", () => {
	assert.doesNotThrow(() => assertServiceTierAgrees("flex", undefined));
	assert.doesNotThrow(() => assertServiceTierAgrees("flex", "auto"));
	assert.doesNotThrow(() => assertServiceTierAgrees("flex", "flex"));
	assert.doesNotThrow(() =>
		assertServiceTierAgrees("fast", "priority", { fast: ["fast", "priority"] }),
	);
	assert.throws(
		() => assertServiceTierAgrees("flex", "priority"),
		/conflicts with the `:flex` model suffix/u,
	);
});
