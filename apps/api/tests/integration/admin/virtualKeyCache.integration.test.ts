import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { test } from "node:test";

import {
	createVirtualKey,
	deleteVirtualKey,
	updateVirtualKey,
} from "#db/repos/virtualKeys.ts";

import {
	getCachedVirtualKeyByHash,
	invalidateVirtualKey,
} from "#auth/virtualKeyCache.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("a lookup racing a revocation cannot re-cache the revoked key", {
	skip,
}, async () => {
	const created = await createVirtualKey({ name: `vkc-${randomUUID()}` });
	const hash = created.row.keyHash;
	try {
		// The lookup starts (reads the generation and the still-enabled row) ...
		const lookup = getCachedVirtualKeyByHash(hash);
		// ... while the key is disabled and its cache invalidated.
		await updateVirtualKey(created.row.id, { enabled: false });
		await invalidateVirtualKey(hash);
		await lookup;
		const after = await getCachedVirtualKeyByHash(hash);
		assert.equal(after?.enabled, false);
	} finally {
		await invalidateVirtualKey(hash);
		await redis.del(`vk:gen:${hash}`);
		await deleteVirtualKey(created.row.id);
	}
});
