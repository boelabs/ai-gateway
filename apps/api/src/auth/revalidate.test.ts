import { revalidateAuth } from "./middleware.ts";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";
import { Hono } from "hono";

test("a session opened with a client secret is re-checked against the key that minted it", async () => {
	const original = redis.get.bind(redis);
	const disabled = {
		id: "k1",
		name: "k",
		allowedModels: [],
		enabled: false,
		expiresAt: null,
		maxBudgetCents: null,
		budgetReset: null,
		budgetResetAt: null,
		spendCents: 0,
		tpm: null,
		rpm: null,
	};
	(redis as unknown as { get: (key: string) => Promise<string> }).get = () =>
		Promise.resolve(JSON.stringify(disabled));
	try {
		const app = new Hono();
		let outcome: unknown;
		app.get("/", async (c) => {
			try {
				await revalidateAuth(c, {
					type: "virtual",
					key: { ...disabled, enabled: true },
					realtimeSecret: { session: null, keyHash: "hash" },
				});
				outcome = "kept";
			} catch (error) {
				outcome = error;
			}
			return c.text("ok");
		});
		await app.request("http://gateway.test/");
		assert.notEqual(outcome, "kept");

		const master = {
			type: "master" as const,
			realtimeSecret: { session: null, keyHash: null },
		};
		const app2 = new Hono();
		let kept: unknown;
		app2.get("/", async (c) => {
			kept = await revalidateAuth(c, master);
			return c.text("ok");
		});
		await app2.request("http://gateway.test/");
		assert.equal(kept, master);
	} finally {
		(redis as unknown as { get: typeof original }).get = original;
	}
});
