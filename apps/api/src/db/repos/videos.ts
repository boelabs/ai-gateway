import { type VideoJobBilling, videoAssets, videoJobs } from "#db/schema.ts";
import type { VideoAssetVariant, VideoStatus } from "#core/videos.ts";
import type { StateScope } from "#auth/scope.ts";
import { writtenRow } from "#db/returning.ts";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";

import {
	inArray,
	isNull,
	desc,
	sql,
	and,
	asc,
	lte,
	eq,
	gt,
	lt,
	or,
} from "drizzle-orm";

export type VideoJobRow = typeof videoJobs.$inferSelect;
export type VideoAssetRow = typeof videoAssets.$inferSelect;

export interface CreateVideoJobInput {
	id: string;
	scope: StateScope;
	publicModel: string;
	deploymentId: string;
	adapterKey: string;
	upstreamModel: string;
	upstreamJobId: string;
	upstreamGenerationId?: string | null;
	upstreamPollingUrl?: string | null;
	providerState?: Record<string, unknown>;
	request: Record<string, unknown>;
	prompt: string;
	seconds?: string | null;
	size?: string | null;
	quality?: string | null;
	status: VideoStatus;
	progress: number;
	error?: Record<string, unknown> | null;
	usage?: Record<string, unknown> | null;
	billing?: VideoJobBilling | null;
	nextPollAt?: Date | null;
}

export interface StoreVideoAssetInput {
	videoId: string;
	variant: VideoAssetVariant;
	objectKey: string;
	storageBackend: string;
	contentType: string;
	contentLength?: number | null;
	etag?: string | null;
	sha256?: string | null;
	expiresAt: Date;
}

export function videoAssetExpiresAt(now = new Date()): Date {
	return new Date(
		now.getTime() + env.VIDEOS_ASSET_RETENTION_HOURS * 60 * 60 * 1000,
	);
}

/**
 * Virtual keys see their own jobs and operator sessions their user's. The master key (both null) is
 * the operator of record and sees every job, so it gets no filter.
 */
function scopeCondition(scope: StateScope) {
	if (scope.virtualKeyId !== null) {
		return eq(videoJobs.virtualKeyId, scope.virtualKeyId);
	}
	if (scope.ownerActor !== null) {
		return and(
			isNull(videoJobs.virtualKeyId),
			eq(videoJobs.ownerActor, scope.ownerActor),
		);
	}
}

export async function createVideoJob(
	input: CreateVideoJobInput,
): Promise<VideoJobRow> {
	const now = new Date();
	const [row] = await db
		.insert(videoJobs)
		.values({
			id: input.id,
			virtualKeyId: input.scope.virtualKeyId,
			ownerActor: input.scope.ownerActor,
			publicModel: input.publicModel,
			deploymentId: input.deploymentId,
			adapterKey: input.adapterKey,
			upstreamModel: input.upstreamModel,
			upstreamJobId: input.upstreamJobId,
			upstreamGenerationId: input.upstreamGenerationId ?? null,
			upstreamPollingUrl: input.upstreamPollingUrl ?? null,
			providerState: input.providerState ?? {},
			request: input.request,
			prompt: input.prompt,
			seconds: input.seconds ?? null,
			size: input.size ?? null,
			quality: input.quality ?? null,
			status: input.status,
			progress: input.progress,
			error: input.error ?? null,
			usage: input.usage ?? null,
			billing: input.billing ?? null,
			expiresAt: videoAssetExpiresAt(now),
			nextPollAt: input.nextPollAt ?? null,
		})
		.returning();
	return writtenRow(row, "createVideoJob");
}

export async function getVideoJobForScope(
	id: string,
	scope: StateScope,
	opts: { includeDeleted?: boolean } = {},
): Promise<VideoJobRow | undefined> {
	const conditions = [eq(videoJobs.id, id), scopeCondition(scope)];
	if (!opts.includeDeleted) {
		conditions.push(isNull(videoJobs.deletedAt));
	}
	const [row] = await db
		.select()
		.from(videoJobs)
		.where(and(...conditions))
		.limit(1);
	return row;
}

export async function getVideoJobById(
	id: string,
): Promise<VideoJobRow | undefined> {
	const [row] = await db
		.select()
		.from(videoJobs)
		.where(eq(videoJobs.id, id))
		.limit(1);
	return row;
}

export async function listVideosForScope(opts: {
	scope: StateScope;
	limit: number;
	after?: string;
	order: "asc" | "desc";
}): Promise<{ rows: VideoJobRow[]; hasMore: boolean }> {
	const conditions = [scopeCondition(opts.scope), isNull(videoJobs.deletedAt)];
	if (opts.after) {
		const after = await getVideoJobForScope(opts.after, opts.scope);
		if (after) {
			// (createdAt, id) tuple comparison so createdAt ties cannot skip rows.
			conditions.push(
				opts.order === "asc"
					? or(
							gt(videoJobs.createdAt, after.createdAt),
							and(
								eq(videoJobs.createdAt, after.createdAt),
								gt(videoJobs.id, after.id),
							),
						)
					: or(
							lt(videoJobs.createdAt, after.createdAt),
							and(
								eq(videoJobs.createdAt, after.createdAt),
								lt(videoJobs.id, after.id),
							),
						),
			);
		}
	}
	const rows = await db
		.select()
		.from(videoJobs)
		.where(and(...conditions))
		.orderBy(
			...(opts.order === "asc"
				? [asc(videoJobs.createdAt), asc(videoJobs.id)]
				: [desc(videoJobs.createdAt), desc(videoJobs.id)]),
		)
		.limit(opts.limit + 1);
	return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
}

/**
 * Atomically takes the right to settle a job's reservation: exactly one caller gets the billing
 * record back, and only while it is still `reserved`.
 */
export async function claimVideoJobBilling(
	id: string,
	outcome: NonNullable<VideoJobBilling["outcome"]>,
): Promise<VideoJobBilling | undefined> {
	const claim = {
		state: "settling",
		claimedAt: new Date().toISOString(),
		outcome,
	};
	const [row] = await db
		.update(videoJobs)
		.set({
			billing: sql`${videoJobs.billing} || ${JSON.stringify(claim)}::jsonb`,
		})
		.where(
			and(
				eq(videoJobs.id, id),
				sql`${videoJobs.billing}->>'state' = 'reserved'`,
			),
		)
		.returning({ billing: videoJobs.billing });
	// The returned state is already `settling`; the lease the caller needs is unchanged.
	return row?.billing ?? undefined;
}

/** Records the outcome of a claimed settlement. */
export async function finishVideoJobBilling(
	id: string,
	billing: VideoJobBilling,
): Promise<void> {
	await db.update(videoJobs).set({ billing }).where(eq(videoJobs.id, id));
}

/**
 * Jobs whose settling claim is older than `before`: the claimant died between taking the claim and
 * finishing it. Claims taken before `claimedAt` existed are judged by the row's last update.
 */
export async function listStaleVideoBillingClaims(
	before: Date,
	limit = 100,
): Promise<Array<{ id: string; billing: VideoJobBilling }>> {
	const rows = await db
		.select({ id: videoJobs.id, billing: videoJobs.billing })
		.from(videoJobs)
		.where(
			and(
				sql`${videoJobs.billing}->>'state' = 'settling'`,
				or(
					sql`(${videoJobs.billing}->>'claimedAt')::timestamptz < ${before.toISOString()}::timestamptz`,
					and(
						sql`${videoJobs.billing}->>'claimedAt' IS NULL`,
						lte(videoJobs.updatedAt, before),
					),
				),
			),
		)
		.limit(limit);
	return rows.flatMap((row) =>
		row.billing ? [{ id: row.id, billing: row.billing }] : [],
	);
}

export async function updateVideoJobState(
	id: string,
	patch: {
		status: VideoStatus;
		progress: number;
		error?: Record<string, unknown> | null;
		usage?: Record<string, unknown> | null;
		upstreamGenerationId?: string | null;
		upstreamPollingUrl?: string | null;
		providerState?: Record<string, unknown>;
		completedAt?: Date | null;
		nextPollAt?: Date | null;
		lastPolledAt?: Date | null;
	},
): Promise<VideoJobRow | undefined> {
	const [row] = await db
		.update(videoJobs)
		.set({
			status: patch.status,
			progress: patch.progress,
			...(patch.error === undefined ? {} : { error: patch.error }),
			...(patch.usage === undefined ? {} : { usage: patch.usage }),
			updatedAt: new Date(),
			...(patch.upstreamGenerationId === undefined
				? {}
				: { upstreamGenerationId: patch.upstreamGenerationId }),
			...(patch.upstreamPollingUrl === undefined
				? {}
				: { upstreamPollingUrl: patch.upstreamPollingUrl }),
			...(patch.providerState === undefined
				? {}
				: { providerState: patch.providerState }),
			...(patch.completedAt === undefined
				? {}
				: { completedAt: patch.completedAt }),
			...(patch.nextPollAt === undefined
				? {}
				: { nextPollAt: patch.nextPollAt }),
			...(patch.lastPolledAt === undefined
				? {}
				: { lastPolledAt: patch.lastPolledAt }),
		})
		.where(eq(videoJobs.id, id))
		.returning();
	return row;
}

export async function storeVideoAsset(
	input: StoreVideoAssetInput,
): Promise<VideoAssetRow> {
	const [row] = await db
		.insert(videoAssets)
		.values({
			videoId: input.videoId,
			variant: input.variant,
			objectKey: input.objectKey,
			storageBackend: input.storageBackend,
			contentType: input.contentType,
			contentLength: input.contentLength ?? null,
			etag: input.etag ?? null,
			sha256: input.sha256 ?? null,
			expiresAt: input.expiresAt,
			deletedAt: null,
		})
		.onConflictDoUpdate({
			target: [videoAssets.videoId, videoAssets.variant],
			set: {
				objectKey: input.objectKey,
				storageBackend: input.storageBackend,
				contentType: input.contentType,
				contentLength: input.contentLength ?? null,
				etag: input.etag ?? null,
				sha256: input.sha256 ?? null,
				expiresAt: input.expiresAt,
				deletedAt: null,
			},
		})
		.returning();
	return writtenRow(row, "storeVideoAsset");
}

export async function getVideoAsset(
	videoId: string,
	variant: VideoAssetVariant,
	now = new Date(),
): Promise<VideoAssetRow | undefined> {
	const [row] = await db
		.select()
		.from(videoAssets)
		.where(
			and(
				eq(videoAssets.videoId, videoId),
				eq(videoAssets.variant, variant),
				isNull(videoAssets.deletedAt),
				gt(videoAssets.expiresAt, now),
			),
		)
		.limit(1);
	return row;
}

export async function markVideoDeletedForScope(
	id: string,
	scope: StateScope,
): Promise<{
	row: VideoJobRow | undefined;
	/** The job's status before the delete, which decides how its reservation settles. */
	previousStatus: VideoJobRow["status"] | undefined;
	assets: VideoAssetRow[];
}> {
	return db.transaction(async (tx) => {
		const now = new Date();
		const [previous] = await tx
			.select({ status: videoJobs.status })
			.from(videoJobs)
			.where(
				and(
					eq(videoJobs.id, id),
					scopeCondition(scope),
					isNull(videoJobs.deletedAt),
				),
			)
			.for("update");
		const [row] = await tx
			.update(videoJobs)
			.set({ status: "deleted", deletedAt: now, updatedAt: now })
			.where(
				and(
					eq(videoJobs.id, id),
					scopeCondition(scope),
					isNull(videoJobs.deletedAt),
				),
			)
			.returning();
		if (!row) {
			return { row: undefined, previousStatus: undefined, assets: [] };
		}
		const assets = await tx
			.update(videoAssets)
			// Make every object immediately eligible for the retrying GC. The endpoint marks only
			// successfully removed objects as deleted, so a storage outage cannot orphan data forever.
			.set({ expiresAt: now })
			.where(and(eq(videoAssets.videoId, id), isNull(videoAssets.deletedAt)))
			.returning();
		return { row, previousStatus: previous?.status, assets };
	});
}

export async function listExpiredVideoAssets(
	now = new Date(),
	limit = 100,
): Promise<VideoAssetRow[]> {
	return db
		.select()
		.from(videoAssets)
		.where(and(isNull(videoAssets.deletedAt), lte(videoAssets.expiresAt, now)))
		.limit(limit);
}

export async function markVideoAssetsDeleted(ids: string[]): Promise<void> {
	if (ids.length === 0) {
		return;
	}
	await db
		.update(videoAssets)
		.set({ deletedAt: new Date() })
		.where(inArray(videoAssets.id, ids));
}

/**
 * Atomically claims a batch of due jobs by pushing their nextPollAt one interval into the
 * future. FOR UPDATE SKIP LOCKED plus the claim window keep concurrent pollers (other gateway
 * instances, an overlapping tick, or a request-path refresh) from double-polling the same job;
 * if a claimer dies mid-refresh the job simply becomes due again.
 */
export async function claimDueVideoJobs(
	now = new Date(),
	limit = env.VIDEO_JOB_POLL_BATCH_SIZE,
	claimMs = env.VIDEO_JOB_POLL_INTERVAL_MS,
): Promise<VideoJobRow[]> {
	return db.transaction(async (tx) => {
		const due = await tx
			.select({ id: videoJobs.id })
			.from(videoJobs)
			.where(
				and(
					inArray(videoJobs.status, ["queued", "in_progress"]),
					isNull(videoJobs.deletedAt),
					or(isNull(videoJobs.nextPollAt), lte(videoJobs.nextPollAt, now)),
				),
			)
			.orderBy(asc(videoJobs.createdAt))
			.limit(limit)
			.for("update", { skipLocked: true });
		if (due.length === 0) {
			return [];
		}
		return tx
			.update(videoJobs)
			.set({ nextPollAt: new Date(now.getTime() + claimMs) })
			.where(
				inArray(
					videoJobs.id,
					due.map((row) => row.id),
				),
			)
			.returning();
	});
}

/**
 * Removes the rows of jobs that are gone for good: deleted or past their asset expiry for longer
 * than `before`, with no stored object left to delete and no budget reservation still to settle
 * (an unsettled one is the reconciler's to finish first). Their asset rows go with them (cascade).
 * Asset rows whose object was deleted long ago are removed too. Batched; returns rows removed.
 */
export async function purgeFinishedVideoRows(
	before: Date,
	limit = 500,
): Promise<number> {
	const iso = before.toISOString();
	const jobs = await db.execute(sql`
		DELETE FROM ${videoJobs}
		WHERE ${videoJobs.id} IN (
			SELECT ${videoJobs.id} FROM ${videoJobs}
			WHERE (
				${videoJobs.deletedAt} < ${iso}::timestamptz
				OR ${videoJobs.expiresAt} < ${iso}::timestamptz
			)
			AND COALESCE(${videoJobs.billing}->>'state', 'settled') NOT IN ('reserved', 'settling')
			AND NOT EXISTS (
				SELECT 1 FROM ${videoAssets}
				WHERE ${videoAssets.videoId} = ${videoJobs.id}
				AND ${videoAssets.deletedAt} IS NULL
			)
			LIMIT ${limit}
		)
		RETURNING ${videoJobs.id}`);
	const assets = await db.execute(sql`
		DELETE FROM ${videoAssets}
		WHERE ${videoAssets.id} IN (
			SELECT ${videoAssets.id} FROM ${videoAssets}
			WHERE ${videoAssets.deletedAt} < ${iso}::timestamptz
			LIMIT ${limit}
		)
		RETURNING ${videoAssets.id}`);
	return jobs.length + assets.length;
}
