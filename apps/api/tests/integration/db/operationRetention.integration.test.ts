import { pgAvailable, redisAvailable } from "#test-support/infra.ts";
import { runOperationMaintenance } from "#logging/operations.ts";
import { gatewayOperations } from "#db/schema.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";
import { test } from "node:test";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("retention removes every expired operation, not one batch per pass", {
	skip,
}, async () => {
	const old = new Date(
		Date.now() - (env.OBSERVABILITY_METADATA_RETENTION_DAYS + 2) * 86_400_000,
	);
	const recent = new Date();
	const expiredIds = Array.from({ length: 1205 }, () => randomUUID());
	const keptId = randomUUID();
	const rows = [
		...expiredIds.map((id) => ({ id, endedAt: old })),
		{ id: keptId, endedAt: recent },
	].map(({ id, endedAt }) => ({
		id,
		requestId: randomUUID(),
		publicModel: "itest-retention",
		callType: "chat",
		lifecycleState: "finished" as const,
		outcome: "error" as const,
		degraded: true,
		startedAt: endedAt,
		endedAt,
	}));
	for (let i = 0; i < rows.length; i += 500) {
		await db.insert(gatewayOperations).values(rows.slice(i, i + 500));
	}
	try {
		await runOperationMaintenance();
		const left = await db
			.select({ id: gatewayOperations.id })
			.from(gatewayOperations)
			.where(inArray(gatewayOperations.id, [...expiredIds, keptId]));
		assert.deepEqual(
			left.map((row) => row.id),
			[keptId],
		);
	} finally {
		await db
			.delete(gatewayOperations)
			.where(inArray(gatewayOperations.id, [...expiredIds, keptId]));
	}
});
