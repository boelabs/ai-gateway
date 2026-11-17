import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadCatalogDocument } from "./jsonCatalog.ts";
import { MODEL_CATALOG } from "#adapters/index.ts";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const catalogs = [
	{
		adapterKey: "openai",
		url: new URL("../adapters/openai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "googleaistudio",
		url: new URL("../adapters/google/catalog.json", import.meta.url),
	},
	{
		adapterKey: "anthropic",
		url: new URL("../adapters/anthropic/catalog.json", import.meta.url),
	},
	{
		adapterKey: "deepseek",
		url: new URL("../adapters/deepseek/catalog.json", import.meta.url),
	},
	{
		adapterKey: "moonshot",
		url: new URL("../adapters/moonshot/catalog.json", import.meta.url),
	},
	{
		adapterKey: "zai",
		url: new URL("../adapters/zai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "minimax",
		url: new URL("../adapters/minimax/catalog.json", import.meta.url),
	},
	{
		adapterKey: "azureopenai",
		url: new URL("../adapters/azureopenai/catalog.json", import.meta.url),
	},
	{
		adapterKey: "azurefoundry",
		url: new URL("../adapters/azurefoundry/catalog.json", import.meta.url),
	},
	{
		adapterKey: "vercel",
		url: new URL("../adapters/vercel/catalog.json", import.meta.url),
	},
	{
		adapterKey: "openrouter",
		url: new URL("../adapters/openrouter/catalog.json", import.meta.url),
	},
] as const;

test("JSON provider catalogs load and match the runtime registry", () => {
	for (const catalog of catalogs) {
		const doc = loadCatalogDocument(catalog.url, {
			adapterKey: catalog.adapterKey,
		});
		assert.equal(doc.schemaVersion, 1);
		assert.equal(doc.provider.adapterKey, catalog.adapterKey);
		assert.deepEqual(
			Object.keys(doc.models).sort(),
			Object.keys(MODEL_CATALOG[catalog.adapterKey] ?? {}).sort(),
			catalog.adapterKey,
		);
	}
});

test("JSON provider catalogs keep model ids as object keys", () => {
	for (const catalog of catalogs) {
		const doc = loadCatalogDocument(catalog.url, {
			adapterKey: catalog.adapterKey,
		});
		for (const [modelId, model] of Object.entries(doc.models)) {
			assert.ok(model.operations, `${catalog.adapterKey}/${modelId}`);
			assert.equal((model as { id?: string }).id ?? modelId, modelId);
		}
	}
});

test("a catalog's provider block rejects fields the loader does not know", () => {
	const source = new URL("../adapters/deepseek/catalog.json", import.meta.url);
	const doc = JSON.parse(readFileSync(source, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	const url = pathToFileURL(join(dir, "catalog.json"));
	try {
		// The provider's name is the adapter's label; a catalog copy would drift from it.
		doc.provider.name = "DeepSeek";
		writeFileSync(url, JSON.stringify(doc));
		assert.throws(() => loadCatalogDocument(url), /unknown field "name"/u);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a Gemini thinkingLevel ladder only declares levels Gemini accepts", () => {
	const source = new URL("../adapters/google/catalog.json", import.meta.url);
	const doc = JSON.parse(readFileSync(source, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	const url = pathToFileURL(join(dir, "catalog.json"));
	const withLevels = (reasoning: Record<string, unknown>) => {
		doc.models["gemini-3.8-flash"].operations["text.generate"].reasoning = {
			kind: "gemini_level",
			...reasoning,
		};
		writeFileSync(url, JSON.stringify(doc));
	};
	try {
		for (const level of ["none", "max"]) {
			withLevels({ levels: ["low", "high", level] });
			assert.throws(
				() => loadCatalogDocument(url),
				/not a Gemini thinkingLevel/u,
			);
		}
		// Gemini 4 Hydrogen introduced xhigh as a native thinkingLevel (Gemini changelog, 2026-11-12).
		withLevels({ levels: ["low", "high", "xhigh"] });
		assert.doesNotThrow(() => loadCatalogDocument(url));
		withLevels({
			levels: ["low", "high", "max"],
			upstreamEffortMap: { max: "high" },
		});
		assert.doesNotThrow(() => loadCatalogDocument(url));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scheduled pricing must be dated, ascending and complete", () => {
	const source = new URL("../adapters/google/catalog.json", import.meta.url);
	const doc = JSON.parse(readFileSync(source, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	const url = pathToFileURL(join(dir, "catalog.json"));
	const withSchedule = (scheduled: unknown) => {
		doc.models["gemini-3.8-flash"].pricing = {
			inputCentsPerMTokens: 75,
			scheduled,
		};
		writeFileSync(url, JSON.stringify(doc));
	};
	try {
		withSchedule([
			{ effectiveFrom: "2027-01-01", pricing: { inputCentsPerMTokens: 150 } },
		]);
		assert.doesNotThrow(() => loadCatalogDocument(url));
		for (const [scheduled, message] of [
			[
				[{ effectiveFrom: "Jan 1", pricing: { inputCentsPerMTokens: 1 } }],
				/YYYY-MM-DD/u,
			],
			[
				[
					{ effectiveFrom: "2027-06-01", pricing: { inputCentsPerMTokens: 1 } },
					{ effectiveFrom: "2027-01-01", pricing: { inputCentsPerMTokens: 2 } },
				],
				/later than the previous/u,
			],
			[[{ effectiveFrom: "2027-01-01", pricing: {} }], /full pricing/u],
			[[], /non-empty array/u],
		] as const) {
			withSchedule(scheduled);
			assert.throws(() => loadCatalogDocument(url), message);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a scheduled price change must keep pricing every service tier", () => {
	const source = new URL("../adapters/google/catalog.json", import.meta.url);
	const doc = JSON.parse(readFileSync(source, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	const url = pathToFileURL(join(dir, "catalog.json"));
	const tier = { inputCentsPerMTokens: 1 };
	const withTiers = (scheduledTiers: Record<string, unknown> | undefined) => {
		doc.models["gemini-3.8-flash"].pricing = {
			inputCentsPerMTokens: 75,
			serviceTiers: { flex: tier, priority: tier },
			scheduled: [
				{
					effectiveFrom: "2027-01-01",
					pricing: {
						inputCentsPerMTokens: 150,
						...(scheduledTiers ? { serviceTiers: scheduledTiers } : {}),
					},
				},
			],
		};
		writeFileSync(url, JSON.stringify(doc));
	};
	try {
		withTiers({ flex: tier, priority: tier });
		assert.doesNotThrow(() => loadCatalogDocument(url));
		for (const tiers of [undefined, { flex: tier }]) {
			withTiers(tiers);
			assert.throws(() => loadCatalogDocument(url), /same service tiers/u);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a retirement date is a real day on a deprecated model", () => {
	const source = new URL("../adapters/deepseek/catalog.json", import.meta.url);
	const doc = JSON.parse(readFileSync(source, "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "catalog-"));
	const url = pathToFileURL(join(dir, "catalog.json"));
	const id = "deepseek-chat";
	const withRetirement = (fields: Record<string, unknown>) => {
		const { deprecated: _d, retiresOn: _r, ...rest } = doc.models[id];
		doc.models[id] = { ...rest, ...fields };
		writeFileSync(url, JSON.stringify(doc));
	};
	try {
		withRetirement({ deprecated: true, retiresOn: "2027-01-31" });
		assert.doesNotThrow(() => loadCatalogDocument(url));
		for (const [fields, message] of [
			[{ deprecated: true, retiresOn: "Jan 31" }, /YYYY-MM-DD/u],
			[{ deprecated: true, retiresOn: "2027-02-30" }, /YYYY-MM-DD/u],
			[{ retiresOn: "2027-01-31" }, /requires deprecated: true/u],
		] as const) {
			withRetirement(fields);
			assert.throws(() => loadCatalogDocument(url), message);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
