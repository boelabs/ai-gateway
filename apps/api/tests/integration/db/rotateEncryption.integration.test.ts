import { createVirtualKey, deleteVirtualKey } from "#db/repos/virtualKeys.ts";
import { pgAvailable, redisAvailable } from "#test-support/infra.ts";
import { spawnSync } from "node:child_process";
import { virtualKeys } from "#db/schema.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("rotation skips and reports rows it cannot open, and fails at the end", {
	skip,
}, async () => {
	const unreadable = await createVirtualKey({ name: `rot-${randomUUID()}` });
	const [row] = await db
		.select({ secret: virtualKeys.secret })
		.from(virtualKeys)
		.where(eq(virtualKeys.id, unreadable.row.id));
	assert.ok(row?.secret);
	// Sealed by a key this keyring does not hold.
	await db
		.update(virtualKeys)
		.set({ secret: { ...(row.secret as object), kid: "retired" } as never })
		.where(eq(virtualKeys.id, unreadable.row.id));
	try {
		const result = spawnSync("bun", ["scripts/rotate-encryption.ts"], {
			env: process.env,
			encoding: "utf8",
		});
		assert.equal(result.status, 1, result.stderr);
		const report = JSON.parse(
			result.stdout.trim().split("\n").at(-1) ?? "{}",
		) as {
			unreadable: Array<{ table: string; id: string }>;
		};
		assert.ok(
			report.unreadable.some(
				(orphan) =>
					orphan.table === "virtual_keys" && orphan.id === unreadable.row.id,
			),
		);
	} finally {
		await deleteVirtualKey(unreadable.row.id);
	}
});
