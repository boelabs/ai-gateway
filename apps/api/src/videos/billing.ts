import { restoreVirtualKeyUsageLease } from "#ratelimit/index.ts";
import type { VirtualKeyUsageLease } from "#ratelimit/index.ts";
import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { videoOutputTokenBound } from "#core/videos.ts";
import type { VideoJobRow } from "#db/repos/videos.ts";
import type { VideoJobBilling } from "#db/schema.ts";
import type { VideoStatus } from "#core/videos.ts";
import { computeCost } from "#logging/cost.ts";
import type { Usage } from "#core/usage.ts";
import { log } from "#logging/log.ts";

import {
	listStaleVideoBillingClaims,
	finishVideoJobBilling,
	claimVideoJobBilling,
} from "#db/repos/videos.ts";

/** The billing record for a job that holds a budget reservation; null when nothing was reserved. */
export function reservedBilling(
	lease: VirtualKeyUsageLease | null,
): VideoJobBilling | null {
	const snapshot = lease?.snapshot();
	return snapshot && snapshot.counters.length > 0
		? { state: "reserved", lease: snapshot }
		: null;
}

/**
 * Usage to bill when the provider reported none for a completed job: the video tokens the profile
 * says the requested duration and size produce. `undefined` when the profile declares no rates.
 */
function estimatedVideoUsage(
	row: Pick<VideoJobRow, "seconds" | "size">,
	meta: Pick<ResolvedModelMetadata, "video">,
): Usage | undefined {
	const tokens = videoOutputTokenBound(meta.video, row);
	if (tokens === undefined) {
		return undefined;
	}
	return {
		promptTokens: 0,
		completionTokens: tokens,
		totalTokens: tokens,
		completionVideoTokens: tokens,
	};
}

type BillingOutcome = NonNullable<VideoJobBilling["outcome"]>;

/**
 * What a job's reservation settles to. Completed jobs are charged their provider-reported usage (or
 * the profile's estimate); a job deleted before it finished is charged the same way unless the
 * provider confirmed the cancellation, since an unconfirmed one may still be generated and billed;
 * failed jobs and confirmed cancellations release the reservation.
 */
function billingOutcome(
	row: Pick<VideoJobRow, "seconds" | "size">,
	status: VideoStatus | "deleted",
	options: {
		meta?: Pick<ResolvedModelMetadata, "pricing" | "video">;
		usage?: Usage;
		cancelConfirmed?: boolean;
	},
): BillingOutcome {
	const charged =
		status === "completed" ||
		(status === "deleted" && options.cancelConfirmed !== true);
	const usage =
		charged && options.meta
			? (options.usage ?? estimatedVideoUsage(row, options.meta))
			: undefined;
	if (!(usage && options.meta)) {
		return { kind: "release" };
	}
	return {
		kind: "settle",
		totalTokens: usage.totalTokens,
		costCents: computeCost(options.meta, usage).totalCents,
		usage: { ...usage },
	};
}

/** Applies a claimed settlement. Spend writes are idempotent per lease, so a retry is harmless. */
async function applyBillingOutcome(
	id: string,
	lease: VirtualKeyUsageLease,
	outcome: BillingOutcome,
): Promise<void> {
	const settledAt = new Date().toISOString();
	if (outcome.kind === "release") {
		await lease.release();
		await finishVideoJobBilling(id, { state: "released", settledAt });
		return;
	}
	await lease.settle(outcome.totalTokens, outcome.costCents);
	await finishVideoJobBilling(id, {
		state: "settled",
		costCents: outcome.costCents,
		usage: outcome.usage,
		settledAt,
	});
}

/**
 * Settles the budget reservation a job made at submit, once, when the job reaches a terminal
 * state (completed, failed, or deleted). The decided outcome is stored with the claim, so a poller
 * that dies mid-settlement leaves enough for `reconcileVideoBilling` to finish it. Never throws:
 * billing must not break polling, and an unsettled reservation expires with its lease.
 */
export async function settleVideoJobBilling(
	row: Pick<VideoJobRow, "id" | "seconds" | "size" | "billing">,
	status: VideoStatus | "deleted",
	options: {
		meta?: Pick<ResolvedModelMetadata, "pricing" | "video">;
		usage?: Usage;
		/** For a deleted job: whether the provider confirmed it cancelled the generation. */
		cancelConfirmed?: boolean;
	},
): Promise<void> {
	if (
		row.billing?.state !== "reserved" ||
		(status !== "completed" && status !== "failed" && status !== "deleted")
	) {
		return;
	}
	try {
		const outcome = billingOutcome(row, status, options);
		const claimed = await claimVideoJobBilling(row.id, outcome);
		if (!claimed?.lease) {
			return;
		}
		await applyBillingOutcome(
			row.id,
			restoreVirtualKeyUsageLease(claimed.lease),
			outcome,
		);
	} catch (err) {
		log.error("videos", "failed to settle video job billing", {
			err,
			videoId: row.id,
		});
	}
}

/** How long a settling claim may stand before the reconciler takes it over. */
export const STALE_BILLING_CLAIM_MS = 5 * 60_000;

/**
 * Finishes settlements whose claimant died: applies the outcome stored with the claim. A claim
 * from before outcomes were stored has nothing to apply, so it releases its reservation. Returns
 * how many it finished.
 */
export async function reconcileVideoBilling(now = new Date()): Promise<number> {
	const stale = await listStaleVideoBillingClaims(
		new Date(now.getTime() - STALE_BILLING_CLAIM_MS),
	);
	let finished = 0;
	for (const { id, billing } of stale) {
		if (!billing.lease) {
			continue;
		}
		try {
			await applyBillingOutcome(
				id,
				restoreVirtualKeyUsageLease(billing.lease),
				billing.outcome ?? { kind: "release" },
			);
			finished += 1;
		} catch (err) {
			log.error("videos", "failed to reconcile video job billing", {
				err,
				videoId: id,
			});
		}
	}
	return finished;
}
