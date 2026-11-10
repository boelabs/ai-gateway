import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { gatewayOperations } from "#db/schema.ts";
import { adminApp } from "#admin/index.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

import "#adapters/index.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("logs page by keyset over a bounded window with list columns only", {
	skip,
}, async () => {
	const app = makeGatewayTestApp((a) => {
		a.route("/admin", adminApp);
	});
	const headers = { authorization: `Bearer ${env.MASTER_KEY}` };
	const model = `paging-${randomUUID()}`;
	const base = Date.now() - 60_000;
	const ids = Array.from({ length: 5 }, () => randomUUID());
	await db.insert(gatewayOperations).values(
		ids.map((id, index) => ({
			id,
			requestId: randomUUID(),
			publicModel: model,
			callType: "chat",
			lifecycleState: "finished" as const,
			outcome: "error" as const,
			degraded: true,
			startedAt: new Date(base + index * 1000),
			endedAt: new Date(base + index * 1000),
		})),
	);
	try {
		const seen: string[] = [];
		let cursor: string | null = null;
		do {
			const query = new URLSearchParams({ publicModel: model, limit: "2" });
			if (cursor) {
				query.set("cursor", cursor);
			}
			const response = await app.request(`/admin/logs?${query}`, { headers });
			assert.equal(response.status, 200);
			const body = (await response.json()) as {
				data: Record<string, unknown>[];
				pagination: { nextCursor: string | null; total: number };
			};
			assert.equal(body.pagination.total, 5);
			for (const row of body.data) {
				assert.equal("requestSummary" in row, false);
				seen.push(String(row.id));
			}
			cursor = body.pagination.nextCursor;
		} while (cursor);
		assert.deepEqual(seen, [...ids].reverse());

		const tooWide = await app.request(
			"/admin/logs?start=2020-01-01T00:00:00Z&end=2026-01-01T00:00:00Z",
			{ headers },
		);
		assert.equal(tooWide.status, 400);
	} finally {
		for (const id of ids) {
			await db.delete(gatewayOperations).where(eq(gatewayOperations.id, id));
		}
	}
});
