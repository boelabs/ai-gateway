import { pgAvailable } from "#test-support/infra.ts";
import { videoJobs } from "#db/schema.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

import {
	updateVideoJobState,
	claimDueVideoJobs,
	createVideoJob,
} from "#db/repos/videos.ts";

const skip = (await pgAvailable()) ? false : "Postgres unavailable";

async function job(status: "queued" | "completed", nextPollAt: Date | null) {
	return createVideoJob({
		id: `video_${randomUUID()}`,
		scope: { virtualKeyId: null, ownerActor: `itest:${randomUUID()}` },
		publicModel: "video-model",
		deploymentId: randomUUID(),
		adapterKey: "openai",
		upstreamModel: "sora-2",
		upstreamJobId: randomUUID(),
		request: {},
		prompt: "p",
		status,
		progress: 0,
		nextPollAt,
	});
}

test("a stale poll cannot move a finished job back", { skip }, async () => {
	const done = await job("completed", null);
	try {
		const written = await updateVideoJobState(done.id, {
			status: "in_progress",
			progress: 10,
		});
		assert.equal(written, undefined);
		const [row] = await db
			.select({ status: videoJobs.status })
			.from(videoJobs)
			.where(eq(videoJobs.id, done.id));
		assert.equal(row?.status, "completed");
	} finally {
		await db.delete(videoJobs).where(eq(videoJobs.id, done.id));
	}
});

test("the most overdue job is claimed first", { skip }, async () => {
	const now = new Date();
	const newer = await job("queued", new Date(now.getTime() - 1000));
	const overdue = await job("queued", new Date(now.getTime() - 60 * 60_000));
	try {
		const claimed = await claimDueVideoJobs(now, 1000);
		const ids = claimed.map((row) => row.id);
		assert.ok(ids.indexOf(overdue.id) < ids.indexOf(newer.id));
	} finally {
		await db.delete(videoJobs).where(eq(videoJobs.id, newer.id));
		await db.delete(videoJobs).where(eq(videoJobs.id, overdue.id));
	}
});
