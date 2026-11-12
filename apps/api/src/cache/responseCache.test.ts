import { cacheSet } from "./responseCache.ts";
import { redis } from "./redis.ts";
import { test } from "node:test";

test("cacheSet never rejects when the Redis write fails", async () => {
	const original = redis.set.bind(redis);
	(redis as unknown as { set: () => Promise<never> }).set = () =>
		Promise.reject(new Error("READONLY"));
	try {
		await cacheSet(
			"cache:test:key",
			{
				body: { ok: true },
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			},
			60,
		);
	} finally {
		(redis as unknown as { set: typeof original }).set = original;
	}
});
