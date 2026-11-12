import type { VirtualKeyAuth } from "./types.ts";
import { redis, runScript } from "#cache/redis.ts";

import {
	getVirtualKeyByHash,
	type VirtualKeyRow,
	hashVirtualKey,
} from "#db/repos/virtualKeys.ts";

const POSITIVE_TTL = 60; // s
const NEGATIVE_TTL = 10; // s (avoids hammering the DB with invalid keys, but short)

function cacheKey(hash: string): string {
	return `vk:${hash}`;
}

/**
 * Bumped by every invalidation. A read-through records it before reading Postgres and stores its
 * result only if it is unchanged, so a lookup that read a key just before it was revoked cannot put
 * the old row back into the cache after the invalidation removed it.
 */
function generationKey(hash: string): string {
	return `vk:gen:${hash}`;
}

// KEYS: cache, generation. ARGV: expected generation, value, ttl.
const SET_IF_CURRENT_LUA = `
if (redis.call('GET', KEYS[2]) or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

function toAuth(row: VirtualKeyRow): VirtualKeyAuth {
	return {
		id: row.id,
		name: row.name,
		allowedModels: row.allowedModels,
		enabled: row.enabled,
		expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
		maxBudgetCents: row.maxBudgetCents,
		budgetReset: row.budgetReset,
		budgetResetAt: row.budgetResetAt ? row.budgetResetAt.toISOString() : null,
		spendCents: Number(row.spendCents),
		tpm: row.tpm,
		rpm: row.rpm,
	};
}

/** Virtual key lookup by its plaintext value, cached in Redis (positive and negative). */
export function getCachedVirtualKey(
	rawKey: string,
): Promise<VirtualKeyAuth | null> {
	return getCachedVirtualKeyByHash(hashVirtualKey(rawKey));
}

/** Virtual key lookup by the hash of its value (what a realtime client secret remembers). */
export async function getCachedVirtualKeyByHash(
	hash: string,
): Promise<VirtualKeyAuth | null> {
	const ck = cacheKey(hash);

	const cached = await redis.get(ck);
	if (cached !== null) {
		return cached === "null" ? null : (JSON.parse(cached) as VirtualKeyAuth);
	}

	const generation = (await redis.get(generationKey(hash))) ?? "0";
	const row = await getVirtualKeyByHash(hash);
	const info = row ? toAuth(row) : null;
	await runScript(
		SET_IF_CURRENT_LUA,
		2,
		ck,
		generationKey(hash),
		generation,
		info ? JSON.stringify(info) : "null",
		String(info ? POSITIVE_TTL : NEGATIVE_TTL),
	);
	return info;
}

/** Invalidates a key's cache by its hash (after update/delete in admin). */
export async function invalidateVirtualKey(hash: string): Promise<void> {
	await redis
		.multi()
		.incr(generationKey(hash))
		// Outlives any read-through that could still be in flight with the previous generation.
		.expire(generationKey(hash), 24 * 60 * 60)
		.del(cacheKey(hash))
		.exec();
}
