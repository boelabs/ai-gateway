import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import { startAttemptWatchdog } from "#gateway/attemptWatchdog.ts";
import type { GatewayAbortReason } from "#gateway/abortReason.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { getEffectiveSettings } from "#router/settings.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { resolveTransport } from "#router/transport.ts";
import { settleVideoJobBilling } from "./billing.ts";
import { getAdapter } from "#adapters/registry.ts";
import type { Adapter } from "#adapters/types.ts";
import type { StateScope } from "#auth/scope.ts";
import { GatewayError } from "#core/errors.ts";
import { decryptRecord } from "#db/crypto.ts";
import { randomUUID } from "node:crypto";
import { redis } from "#cache/redis.ts";
import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";

import {
	markVideoAssetsDeleted,
	listExpiredVideoAssets,
	updateVideoJobState,
	type VideoAssetRow,
	claimDueVideoJobs,
	type VideoJobRow,
	getVideoJobById,
	storeVideoAsset,
	getVideoAsset,
} from "#db/repos/videos.ts";

import type {
	CanonicalVideoProviderJob,
	CanonicalVideoObject,
	VideoAssetVariant,
	VideoQuality,
	VideoStatus,
} from "#core/videos.ts";

import {
	contentTypeForKey,
	type ObjectRange,
	getObjectStore,
	objectKey,
} from "#storage/objectStore.ts";

import {
	type DeploymentRow,
	getDeploymentById,
} from "#db/repos/deployments.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "deleted"]);

export function newVideoId(): string {
	return `video_${randomUUID().replaceAll("-", "")}`;
}

export function videoObjectFromRow(row: VideoJobRow): CanonicalVideoObject {
	return {
		id: row.id,
		model: row.publicModel,
		status: row.status === "deleted" ? "failed" : (row.status as VideoStatus),
		progress: row.progress,
		prompt: row.prompt,
		createdAt: row.createdAt,
		completedAt: row.completedAt,
		expiresAt: row.expiresAt,
		error: (row.error as CanonicalVideoObject["error"]) ?? null,
		remixedFromVideoId: null,
		...(row.seconds === null ? {} : { seconds: row.seconds }),
		...(row.size === null ? {} : { size: row.size }),
		...(row.quality === null ? {} : { quality: row.quality as VideoQuality }),
	};
}

function nextPollAt(
	job: CanonicalVideoProviderJob,
	pollIntervalSeconds?: number,
): Date | null {
	if (job.status === "completed" || job.status === "failed") {
		return null;
	}
	return new Date(
		Date.now() +
			(pollIntervalSeconds ?? env.VIDEO_JOB_POLL_INTERVAL_MS / 1000) * 1000,
	);
}

function shouldTimeOut(row: VideoJobRow, now = new Date()): boolean {
	return (
		now.getTime() - row.createdAt.getTime() >
		env.VIDEO_JOB_MAX_RUNTIME_MINUTES * 60 * 1000
	);
}

async function candidateFromJob(
	row: VideoJobRow,
	signal?: AbortSignal,
	mode: "json" | "stream" = "json",
): Promise<{
	candidate: DeploymentCandidate;
	/** Guaranteed present: an adapter without it is refused above. */
	videoGeneration: NonNullable<Adapter["videoGeneration"]>;
	ctx: AdapterContext;
	cleanup: () => void;
}> {
	const deployment = await getDeploymentById(row.deploymentId ?? "");
	if (!deployment) {
		throw new GatewayError({
			class: "server",
			code: "video_deployment_missing",
			message: `Video job ${row.id} references missing deployment ${row.deploymentId}`,
		});
	}
	const adapter = getAdapter(deployment.adapterKey);
	if (!adapter?.videoGeneration) {
		throw new GatewayError({
			class: "server",
			code: "video_adapter_missing",
			message: `Adapter "${deployment.adapterKey}" does not implement video generation`,
		});
	}
	const meta = resolveModelMetadata(
		deployment.adapterKey,
		deployment.upstreamModel,
		deployment.catalogEntry,
		deployment.pricing,
	);
	const candidate: DeploymentCandidate = {
		row: deployment as DeploymentRow,
		adapter,
		upstreamModel: deployment.upstreamModel,
		meta,
	};
	const settings = await getEffectiveSettings();
	const policy = settings.executionPolicies["videos.generations"][mode];
	const controller = new AbortController();
	const abortFromCaller = () =>
		controller.abort({ owner: "client", type: "cancelled" });
	if (signal?.aborted) {
		abortFromCaller();
	} else {
		signal?.addEventListener("abort", abortFromCaller, { once: true });
	}
	const abort = (reason: GatewayAbortReason) => {
		if (!controller.signal.aborted) {
			controller.abort(reason);
		}
	};
	const watchdog = startAttemptWatchdog(policy, mode, abort);
	const timer = setTimeout(
		() => abort({ owner: "gateway", type: "timeout", phase: "total" }),
		policy.totalMs,
	);
	timer.unref?.();
	const ctx: AdapterContext = {
		upstreamModel: deployment.upstreamModel,
		credentials: decryptRecord(
			deployment.credentials,
			"deployment-credentials",
		),
		meta,
		transport: resolveTransport(candidate, "videos.generations"),
		requestId: row.id,
		watchdog,
		diagnostics: {},
		signal: controller.signal,
	};
	return {
		candidate,
		videoGeneration: adapter.videoGeneration,
		ctx,
		cleanup: () => {
			watchdog.stop();
			clearTimeout(timer);
			signal?.removeEventListener("abort", abortFromCaller);
			abort({ owner: "gateway", type: "settled" });
		},
	};
}

async function applyProviderJob(
	row: VideoJobRow,
	job: CanonicalVideoProviderJob,
	meta: ResolvedModelMetadata,
): Promise<VideoJobRow> {
	const pollIntervalSeconds = meta.video?.pollIntervalSeconds;
	const now = new Date();
	const updated = await updateVideoJobState(row.id, {
		status: job.status,
		progress: Math.max(
			0,
			Math.min(
				100,
				job.progress ?? (job.status === "completed" ? 100 : row.progress),
			),
		),
		error: job.error ?? null,
		usage: job.usage ?? row.usage,
		upstreamGenerationId: job.upstreamGenerationId ?? row.upstreamGenerationId,
		upstreamPollingUrl: job.upstreamPollingUrl ?? row.upstreamPollingUrl,
		providerState: job.providerState ?? row.providerState,
		completedAt:
			job.status === "completed" ? (row.completedAt ?? now) : row.completedAt,
		lastPolledAt: now,
		nextPollAt: nextPollAt(job, pollIntervalSeconds),
	});
	await settleVideoJobBilling(row, job.status, {
		meta,
		...(job.coreUsage ? { usage: job.coreUsage } : {}),
	});
	return updated ?? row;
}

export async function refreshVideoJob(
	row: VideoJobRow,
	signal?: AbortSignal,
): Promise<VideoJobRow> {
	if (TERMINAL_STATUSES.has(row.status)) {
		return row;
	}
	if (shouldTimeOut(row)) {
		const timedOut = await updateVideoJobState(row.id, {
			status: "failed",
			progress: row.progress,
			error: {
				code: "job_timeout",
				message: "Video generation exceeded the gateway timeout window.",
			},
			lastPolledAt: new Date(),
			nextPollAt: null,
		});
		await settleVideoJobBilling(row, "failed", {});
		return timedOut ?? row;
	}
	const { candidate, videoGeneration, ctx, cleanup } = await candidateFromJob(
		row,
		signal,
	);
	try {
		const providerJob = await videoGeneration.refresh(
			{
				upstreamJobId: row.upstreamJobId,
				upstreamGenerationId: row.upstreamGenerationId,
				upstreamPollingUrl: row.upstreamPollingUrl,
				providerState: row.providerState,
			},
			ctx,
		);
		return await applyProviderJob(row, providerJob, candidate.meta);
	} finally {
		cleanup();
	}
}

function variantExtension(
	variant: VideoAssetVariant,
	contentType: string,
): string {
	if (variant === "video") {
		if (contentType === "video/webm") {
			return "webm";
		}
		return "mp4";
	}
	if (contentType === "image/png") {
		return "png";
	}
	return "jpg";
}

function makeObjectKey(
	row: VideoJobRow,
	variant: VideoAssetVariant,
	contentType: string,
): string {
	const date = row.createdAt;
	const yyyy = String(date.getUTCFullYear());
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	return objectKey("videos", [
		yyyy,
		mm,
		dd,
		row.id,
		`${variant}.${variantExtension(variant, contentType)}`,
	]);
}

/** Ingestions running in this process, so concurrent requests for one asset share one download. */
const ingesting = new Map<string, Promise<VideoAssetRow>>();
/** How long an ingestion may hold the cross-replica lock; a crashed holder frees it after this. */
const INGEST_LOCK_MS = 10 * 60_000;
const INGEST_WAIT_MS = 30_000;
const INGEST_POLL_MS = 500;

/**
 * The stored asset for a completed job, downloading it from the provider the first time. One
 * download per (video, variant) at a time across every replica: the first caller takes a Redis
 * lock and ingests, the others wait for its row instead of fetching the same file again.
 */
export function ensureVideoAsset(
	inputRow: VideoJobRow,
	variant: VideoAssetVariant,
	signal?: AbortSignal,
): Promise<VideoAssetRow> {
	const key = `${inputRow.id}:${variant}`;
	const running = ingesting.get(key);
	if (running) {
		return running;
	}
	const task = ensureVideoAssetOnce(inputRow, variant, signal).finally(() => {
		ingesting.delete(key);
	});
	ingesting.set(key, task);
	return task;
}

async function ensureVideoAssetOnce(
	inputRow: VideoJobRow,
	variant: VideoAssetVariant,
	signal?: AbortSignal,
): Promise<VideoAssetRow> {
	const lockKey = `video-ingest:${inputRow.id}:${variant}`;
	const token = randomUUID();
	const deadline = Date.now() + INGEST_WAIT_MS;
	while (
		(await redis.set(lockKey, token, "PX", INGEST_LOCK_MS, "NX")) !== "OK"
	) {
		const stored = await getVideoAsset(inputRow.id, variant);
		if (stored) {
			return stored;
		}
		if (Date.now() >= deadline) {
			throw new GatewayError({
				class: "server",
				status: 503,
				code: "video_ingest_in_progress",
				message: `Video ${inputRow.id} is being stored by another replica`,
				publicMessage: "The video is still being prepared. Retry shortly.",
				retryAfterMs: 5000,
			});
		}
		signal?.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, INGEST_POLL_MS));
	}
	try {
		return await ingestVideoAsset(inputRow, variant, signal);
	} finally {
		// Released only by its holder: compare-and-delete, so an expired lock taken over by another
		// replica is never released from under it.
		await redis
			.eval(
				"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
				1,
				lockKey,
				token,
			)
			.catch(() => undefined);
	}
}

async function ingestVideoAsset(
	inputRow: VideoJobRow,
	variant: VideoAssetVariant,
	signal?: AbortSignal,
): Promise<VideoAssetRow> {
	if (inputRow.expiresAt.getTime() <= Date.now()) {
		throw new GatewayError({
			class: "not_found",
			code: "video_expired",
			message: `Video ${inputRow.id} content has expired`,
			publicMessage: "The video content has expired.",
		});
	}
	const existing = await getVideoAsset(inputRow.id, variant);
	if (existing) {
		return existing;
	}

	let row = inputRow;
	if (!TERMINAL_STATUSES.has(row.status)) {
		row = await refreshVideoJob(row, signal);
	}
	if (row.status !== "completed") {
		throw new GatewayError({
			class: "bad_request",
			status: 409,
			code: "video_not_ready",
			message: `Video ${row.id} is not completed yet`,
			publicMessage: "The video is not completed yet.",
		});
	}

	const { videoGeneration, ctx, cleanup } = await candidateFromJob(
		row,
		signal,
		"stream",
	);
	try {
		const content = await videoGeneration.download(
			{
				upstreamJobId: row.upstreamJobId,
				upstreamGenerationId: row.upstreamGenerationId,
				upstreamPollingUrl: row.upstreamPollingUrl,
				providerState: row.providerState,
			},
			variant,
			ctx,
		);
		const store = getObjectStore();
		const key = makeObjectKey(row, variant, content.contentType);
		const stored = await store.put({
			key,
			body: content.body,
			contentType: content.contentType,
			...(content.contentLength === undefined
				? {}
				: { contentLength: content.contentLength }),
		});
		return storeVideoAsset({
			videoId: row.id,
			variant,
			objectKey: key,
			storageBackend: store.backend,
			contentType: content.contentType,
			contentLength: content.contentLength ?? null,
			etag: stored.etag ?? null,
			expiresAt: row.expiresAt,
		});
	} finally {
		cleanup();
	}
}

export async function readVideoAsset(
	asset: VideoAssetRow,
	range?: ObjectRange,
) {
	if (asset.expiresAt.getTime() <= Date.now()) {
		throw new GatewayError({
			class: "not_found",
			code: "video_expired",
			message: "Video asset has expired",
			publicMessage: "The video content has expired.",
		});
	}
	return getObjectStore().get(asset.objectKey, range);
}

export async function deleteExpiredVideoAssets(): Promise<number> {
	const store = getObjectStore();
	const expired = await listExpiredVideoAssets(new Date(), 100);
	const deletedIds: string[] = [];
	for (const asset of expired) {
		try {
			await store.delete(asset.objectKey);
			deletedIds.push(asset.id);
		} catch (err) {
			log.warn("videos", "failed to delete expired video asset object", {
				err,
				assetId: asset.id,
				key: asset.objectKey,
			});
		}
	}
	await markVideoAssetsDeleted(deletedIds);
	return deletedIds.length;
}

export async function refreshDueVideoJobs(): Promise<number> {
	const rows = await claimDueVideoJobs();
	let refreshed = 0;
	for (const row of rows) {
		try {
			const updated = await refreshVideoJob(row);
			if (updated.status === "completed") {
				await ensureVideoAsset(updated, "video").catch((err: unknown) => {
					log.warn("videos", "completed video asset ingestion failed", {
						err,
						videoId: updated.id,
					});
				});
			}
			refreshed += 1;
		} catch (err) {
			log.warn("videos", "video refresh failed", { err, videoId: row.id });
		}
	}
	return refreshed;
}

export async function loadAndRefreshVideo(
	id: string,
	scope: StateScope,
	signal?: AbortSignal,
): Promise<VideoJobRow> {
	const row = await getVideoJobById(id);
	if (!row || row.deletedAt) {
		throw new GatewayError({
			class: "not_found",
			code: "video_not_found",
			message: `Video ${id} not found`,
		});
	}
	// Keys and operator sessions see their own jobs; the master key is the operator and sees all.
	if (
		(scope.virtualKeyId !== null && row.virtualKeyId !== scope.virtualKeyId) ||
		(scope.virtualKeyId === null &&
			scope.ownerActor !== null &&
			(row.virtualKeyId !== null || row.ownerActor !== scope.ownerActor))
	) {
		throw new GatewayError({
			class: "not_found",
			code: "video_not_found",
			message: `Video ${id} not found in scope`,
		});
	}
	if (row.nextPollAt && row.nextPollAt.getTime() > Date.now()) {
		return row;
	}
	return refreshVideoJob(row, signal);
}

/**
 * Upstream delete/cancel after a local delete, then the job's terminal billing transition. The
 * provider call is best effort: a failure is logged, never surfaced, because the local soft-delete
 * already succeeded and not every provider has a delete endpoint. A job that was still running is
 * released only when the provider confirmed the cancellation; otherwise it may still be generated
 * and billed upstream, so its reservation settles at the profile's estimate.
 */
export async function removeUpstreamVideo(
	row: VideoJobRow,
	previousStatus: VideoJobRow["status"] | undefined,
): Promise<void> {
	let cancelConfirmed = false;
	let meta: ResolvedModelMetadata | undefined;
	try {
		const { candidate, ctx, cleanup } = await candidateFromJob(row);
		({ meta } = candidate);
		try {
			const remove = candidate.adapter.videoGeneration?.remove;
			if (remove) {
				await remove(
					{
						upstreamJobId: row.upstreamJobId,
						upstreamGenerationId: row.upstreamGenerationId,
						upstreamPollingUrl: row.upstreamPollingUrl,
						providerState: row.providerState,
					},
					ctx,
				);
				cancelConfirmed = true;
			}
		} finally {
			cleanup();
		}
	} catch (err) {
		log.warn("videos", "best-effort upstream video delete failed", {
			err,
			videoId: row.id,
		});
	}
	if (previousStatus !== undefined && !TERMINAL_STATUSES.has(previousStatus)) {
		await settleVideoJobBilling(row, "deleted", {
			cancelConfirmed,
			...(meta ? { meta } : {}),
		});
	}
}

export function storedContentHeaders(
	asset: VideoAssetRow,
): Record<string, string> {
	return {
		"content-type": asset.contentType || contentTypeForKey(asset.objectKey),
		"accept-ranges": "bytes",
		"cache-control": "private, max-age=60",
		...(asset.contentLength === null
			? {}
			: { "content-length": String(asset.contentLength) }),
	};
}
