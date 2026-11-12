import { createVideoJob, purgeFinishedVideoRows } from "#db/repos/videos.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { reserveVirtualKeyUsage } from "#ratelimit/index.ts";
import { videoJobs } from "#db/schema.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { redis } from "#cache/redis.ts";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

import {
	STALE_BILLING_CLAIM_MS,
	settleVideoJobBilling,
	reconcileVideoBilling,
	reservedBilling,
} from "#videos/billing.ts";

import {
	recordVirtualKeySpend,
	getVirtualKeyById,
	createVirtualKey,
	deleteVirtualKey,
} from "#db/repos/virtualKeys.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

async function budgetedKey() {
	const created = await createVirtualKey({
		name: `ledger-${randomUUID()}`,
		maxBudgetCents: 1000,
	});
	const { row } = created;
	return {
		row,
		auth: {
			id: row.id,
			name: row.name,
			allowedModels: [],
			enabled: true,
			expiresAt: null,
			maxBudgetCents: 1000,
			budgetReset: null,
			budgetResetAt: null,
			spendCents: 0,
			tpm: null,
			rpm: null,
		},
	};
}

async function cleanup(keyId: string): Promise<void> {
	await redis.del(
		`ratelimit:v2:budget:${keyId}`,
		`ratelimit:v2:budget-reserved:${keyId}`,
		`ratelimit:v2:budget-leases:${keyId}`,
		`ratelimit:v2:budget-amounts:${keyId}`,
	);
	await deleteVirtualKey(keyId);
}

async function spend(keyId: string): Promise<number> {
	return Number((await getVirtualKeyById(keyId))?.spendCents ?? 0);
}

async function videoJob(keyId: string, billing: unknown, status = "queued") {
	return createVideoJob({
		id: `video_${randomUUID()}`,
		scope: { virtualKeyId: keyId, ownerActor: null },
		publicModel: "video-model",
		deploymentId: randomUUID(),
		adapterKey: "openai",
		upstreamModel: "sora-2",
		upstreamJobId: randomUUID(),
		request: {},
		prompt: "a cat",
		seconds: "4",
		size: "1280x720",
		status: status as "queued",
		progress: 0,
		billing: billing as never,
	});
}

const PRICING = { pricing: { outputCentsPerMTokens: 1_000_000 } };

test("spend is applied once per ledger entry", { skip }, async () => {
	const { row } = await budgetedKey();
	try {
		const entry = randomUUID();
		assert.equal(await recordVirtualKeySpend(entry, row.id, 5), true);
		assert.equal(await recordVirtualKeySpend(entry, row.id, 5), false);
		assert.equal(await spend(row.id), 5);
	} finally {
		await cleanup(row.id);
	}
});

test("a stale settling claim is finished with the outcome stored on it", {
	skip,
}, async () => {
	const { row, auth } = await budgetedKey();
	try {
		const lease = await reserveVirtualKeyUsage(auth, 0, 100);
		const job = await videoJob(row.id, reservedBilling(lease));
		const claimedAt = new Date(Date.now() - STALE_BILLING_CLAIM_MS - 1000);
		await db
			.update(videoJobs)
			.set({
				billing: {
					state: "settling",
					lease: lease.snapshot(),
					claimedAt: claimedAt.toISOString(),
					outcome: {
						kind: "settle",
						totalTokens: 10,
						costCents: 7,
						usage: { promptTokens: 0, completionTokens: 10, totalTokens: 10 },
					},
				},
			})
			.where(eq(videoJobs.id, job.id));
		assert.ok((await reconcileVideoBilling()) >= 1);
		const [after] = await db
			.select({ billing: videoJobs.billing })
			.from(videoJobs)
			.where(eq(videoJobs.id, job.id));
		assert.equal(after?.billing?.state, "settled");
		assert.equal(after?.billing?.costCents, 7);
		assert.equal(await spend(row.id), 7);
		// Reconciling again finds nothing to do and charges nothing twice.
		await reconcileVideoBilling();
		assert.equal(await spend(row.id), 7);
		await db.delete(videoJobs).where(eq(videoJobs.id, job.id));
	} finally {
		await cleanup(row.id);
	}
});

test("deleting a running job settles unless the cancellation was confirmed", {
	skip,
}, async () => {
	const { row, auth } = await budgetedKey();
	try {
		const charged = await videoJob(
			row.id,
			reservedBilling(await reserveVirtualKeyUsage(auth, 0, 100)),
		);
		await settleVideoJobBilling(charged, "deleted", {
			meta: PRICING,
			usage: { promptTokens: 0, completionTokens: 3, totalTokens: 3 },
			cancelConfirmed: false,
		});
		const cancelled = await videoJob(
			row.id,
			reservedBilling(await reserveVirtualKeyUsage(auth, 0, 100)),
		);
		await settleVideoJobBilling(cancelled, "deleted", {
			meta: PRICING,
			usage: { promptTokens: 0, completionTokens: 3, totalTokens: 3 },
			cancelConfirmed: true,
		});
		const states = await db
			.select({ id: videoJobs.id, billing: videoJobs.billing })
			.from(videoJobs)
			.where(eq(videoJobs.virtualKeyId, row.id));
		const byId = new Map(states.map((state) => [state.id, state.billing]));
		assert.equal(byId.get(charged.id)?.state, "settled");
		assert.equal(byId.get(cancelled.id)?.state, "released");
		assert.equal(await spend(row.id), 3);
		await db.delete(videoJobs).where(eq(videoJobs.virtualKeyId, row.id));
	} finally {
		await cleanup(row.id);
	}
});

test("finished video rows are purged once nothing is left to settle or delete", {
	skip,
}, async () => {
	const { row } = await budgetedKey();
	try {
		const gone = await videoJob(row.id, null, "completed");
		const unsettled = await videoJob(
			row.id,
			reservedBilling(await reserveVirtualKeyUsage(row as never, 0, 0)) ?? {
				state: "reserved",
				lease: { keyId: row.id, tpmFirst: false, counters: [] },
			},
			"completed",
		);
		const old = new Date(Date.now() - 30 * 86_400_000);
		await db
			.update(videoJobs)
			.set({ deletedAt: old })
			.where(eq(videoJobs.virtualKeyId, row.id));
		await purgeFinishedVideoRows(new Date(Date.now() - 7 * 86_400_000));
		const left = await db
			.select({ id: videoJobs.id })
			.from(videoJobs)
			.where(eq(videoJobs.virtualKeyId, row.id));
		assert.deepEqual(
			left.map((job) => job.id),
			[unsettled.id],
		);
		assert.ok(!left.some((job) => job.id === gone.id));
		await db.delete(videoJobs).where(eq(videoJobs.virtualKeyId, row.id));
	} finally {
		await cleanup(row.id);
	}
});
