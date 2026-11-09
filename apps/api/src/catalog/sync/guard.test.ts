import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
	AZURE_LISTING_PATH,
	guardAzureListing,
	guardChangedFiles,
	catalogDirectory,
	guardCatalog,
} from "./guard.ts";

const catalog = (models: Record<string, unknown>) => ({ models });

describe("guardChangedFiles", () => {
	test("allows catalog files only", () => {
		assert.deepEqual(
			guardChangedFiles([
				"apps/api/src/adapters/openai/catalog.json",
				"apps/api/src/adapters/vercel/catalog.json",
			]),
			[],
		);
		const findings = guardChangedFiles([
			"apps/api/src/adapters/openai/index.ts",
			"AGENTS.md",
		]);
		assert.deepEqual(
			findings.map((f) => f.level),
			["block", "block"],
		);
	});

	test("sends a change to the Azure unserved list to a human", () => {
		assert.deepEqual(
			guardChangedFiles([AZURE_LISTING_PATH]).map((f) => f.level),
			["review"],
		);
	});

	test("reads the adapter directory from a catalog path", () => {
		assert.equal(
			catalogDirectory("apps/api/src/adapters/zai/catalog.json"),
			"zai",
		);
		assert.equal(
			catalogDirectory("apps/api/src/adapters/zai/index.ts"),
			undefined,
		);
	});
});

describe("guardCatalog", () => {
	test("accepts additions, deprecations and small price moves", () => {
		const before = catalog({
			a: { pricing: { inputCentsPerMTokens: 100, outputCentsPerMTokens: 400 } },
		});
		const after = catalog({
			a: {
				deprecated: true,
				pricing: { inputCentsPerMTokens: 120, outputCentsPerMTokens: 400 },
			},
			b: { pricing: { inputCentsPerMTokens: 10 } },
		});
		assert.deepEqual(guardCatalog("openai", before, after), []);
	});

	test("blocks removing a model from a hand-maintained catalog", () => {
		const findings = guardCatalog("openai", catalog({ a: {} }), catalog({}));
		assert.deepEqual(findings, [
			{
				level: "block",
				message: "openai/a was removed; mark it deprecated instead",
			},
		]);
	});

	test("lets generated snapshots drop models", () => {
		assert.deepEqual(
			guardCatalog("vercel", catalog({ a: {} }), catalog({})),
			[],
		);
	});

	test("blocks reversing a deprecation", () => {
		const findings = guardCatalog(
			"minimax",
			catalog({ a: { deprecated: true } }),
			catalog({ a: {} }),
		);
		assert.deepEqual(
			findings.map((f) => f.level),
			["block"],
		);
	});

	test("sends large or removed price changes to a human, tiers included", () => {
		const before = catalog({
			a: {
				pricing: {
					inputCentsPerMTokens: 1000,
					cacheReadCentsPerMTokens: 100,
					tiers: [{ aboveInputTokens: 272_000, inputCentsPerMTokens: 400 }],
				},
			},
		});
		const after = catalog({
			a: {
				pricing: {
					inputCentsPerMTokens: 500,
					tiers: [{ aboveInputTokens: 272_000, inputCentsPerMTokens: 900 }],
				},
			},
		});
		assert.deepEqual(guardCatalog("anthropic", before, after), [
			{
				level: "review",
				message: "anthropic/a: pricing.inputCentsPerMTokens 1000 -> 500",
			},
			{
				level: "review",
				message:
					"anthropic/a: pricing.cacheReadCentsPerMTokens removed (was 100)",
			},
			{
				level: "review",
				message:
					"anthropic/a: pricing.tiers[>272000].inputCentsPerMTokens 400 -> 900",
			},
		]);
	});

	test("treats a price moving to or from zero as large", () => {
		const findings = guardCatalog(
			"zai",
			catalog({ a: { pricing: { outputCentsPerMTokens: 0 } } }),
			catalog({ a: { pricing: { outputCentsPerMTokens: 40 } } }),
		);
		assert.deepEqual(
			findings.map((f) => f.level),
			["review"],
		);
	});
});

describe("guardAzureListing", () => {
	const model = (id: string) => ({
		adapterKey: "azurefoundry",
		id,
		section: "Moonshot AI models sold by Azure",
		retired: false,
	});

	test("passes when every listed id is resolved", () => {
		assert.deepEqual(
			guardAzureListing({
				complete: true,
				missing: [],
				retiredNotDeprecated: [],
			}),
			[],
		);
	});

	test("holds the merge for missing and retired ids", () => {
		assert.deepEqual(
			guardAzureListing({
				complete: true,
				missing: [model("Kimi-K3.1-Pro")],
				retiredNotDeprecated: [{ ...model("Kimi-K2.5"), retired: true }],
			}),
			[
				{
					level: "review",
					message:
						"azurefoundry/Kimi-K3.1-Pro: listed by Azure (Moonshot AI models sold by Azure), neither in the catalog nor in AZURE_LISTING_UNSERVED",
				},
				{
					level: "review",
					message:
						"azurefoundry/Kimi-K2.5: retired by Azure, not deprecated here",
				},
			],
		);
	});

	test("holds the merge when the list cannot be read", () => {
		assert.deepEqual(
			guardAzureListing({
				complete: false,
				error: "HTTP 503",
				missing: [],
				retiredNotDeprecated: [],
			}).map((f) => f.level),
			["review"],
		);
	});
});
