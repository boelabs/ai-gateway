import { getDashboardSettings } from "#db/repos/dashboardSettings.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { reserveLoginAttempt } from "#auth/loginThrottle.ts";
import { GatewayError } from "#core/errors.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

function ipAddress(): string {
	const n = Math.floor(Math.random() * 250) + 1;
	return `198.51.${n}.${Math.floor(Math.random() * 250) + 1}`;
}

async function cleanup(): Promise<void> {
	const keys = await redis.keys("login-fail:v2:*");
	if (keys.length > 0) {
		await redis.del(...keys);
	}
}

function locked(error: unknown): boolean {
	return GatewayError.is(error) && error.code === "login_locked_out";
}

test("concurrent guesses cannot exceed the limit for one client", {
	skip,
}, async () => {
	const { loginMaxAttempts } = await getDashboardSettings();
	const username = `user-${randomUUID().slice(0, 8)}`;
	const ip = ipAddress();
	try {
		const results = await Promise.allSettled(
			Array.from({ length: loginMaxAttempts * 3 }, () =>
				reserveLoginAttempt(username, ip, null),
			),
		);
		const allowed = results.filter((result) => result.status === "fulfilled");
		assert.equal(allowed.length, loginMaxAttempts);
		assert.ok(
			results.every(
				(result) => result.status === "fulfilled" || locked(result.reason),
			),
		);
	} finally {
		await cleanup();
	}
});

test("another address cannot lock a user out", { skip }, async () => {
	const { loginMaxAttempts } = await getDashboardSettings();
	const username = `user-${randomUUID().slice(0, 8)}`;
	const attacker = ipAddress();
	try {
		for (let i = 0; i < loginMaxAttempts; i += 1) {
			await reserveLoginAttempt(username, attacker, null);
		}
		await assert.rejects(reserveLoginAttempt(username, attacker, null), locked);
		await reserveLoginAttempt(username, ipAddress(), null);
	} finally {
		await cleanup();
	}
});

test("signing into one account does not reset another account's counters", {
	skip,
}, async () => {
	const { loginMaxAttempts } = await getDashboardSettings();
	const victim = `victim-${randomUUID().slice(0, 8)}`;
	const own = `own-${randomUUID().slice(0, 8)}`;
	const ip = ipAddress();
	try {
		for (let i = 0; i < loginMaxAttempts; i += 1) {
			await reserveLoginAttempt(victim, ip, null);
		}
		const mine = await reserveLoginAttempt(own, ip, null);
		await mine.succeeded();
		await assert.rejects(reserveLoginAttempt(victim, ip, null), locked);
	} finally {
		await cleanup();
	}
});

test("an invented username creates no per-username counter", {
	skip,
}, async () => {
	try {
		await reserveLoginAttempt("x".repeat(200), ipAddress(), null);
		assert.deepEqual(await redis.keys("login-fail:v2:u:*"), []);
		await reserveLoginAttempt("Root@Example", ipAddress(), "root@example");
		assert.equal((await redis.keys("login-fail:v2:u:*")).length, 1);
	} finally {
		await cleanup();
	}
});
