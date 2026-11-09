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

/**
 * Settles the budget reservation a job made at submit, once, when the job reaches a terminal
 * state. Completed jobs are charged their provider-reported usage (or, failing that, the profile's
 * estimate); failed jobs release the reservation. Never throws: billing must not break polling,
 * and an unsettled reservation expires with its lease.
 */
export async function settleVideoJobBilling(
	row: Pick<VideoJobRow, "id" | "seconds" | "size" | "billing">,
	status: VideoStatus,
	options: {
		meta?: Pick<ResolvedModelMetadata, "pricing" | "video">;
		usage?: Usage;
	},
): Promise<void> {
	if (
		row.billing?.state !== "reserved" ||
		(status !== "completed" && status !== "failed")
	) {
		return;
	}
	try {
		const claimed = await claimVideoJobBilling(row.id);
		if (!claimed?.lease) {
			return;
		}
		const lease = restoreVirtualKeyUsageLease(claimed.lease);
		const usage =
			status === "completed" && options.meta
				? (options.usage ?? estimatedVideoUsage(row, options.meta))
				: undefined;
		if (!(usage && options.meta)) {
			await lease.release();
			await finishVideoJobBilling(row.id, {
				state: "released",
				settledAt: new Date().toISOString(),
			});
			return;
		}
		const { totalCents } = computeCost(options.meta, usage);
		await lease.settle(usage.totalTokens, totalCents);
		const settled: VideoJobBilling = {
			state: "settled",
			costCents: totalCents,
			usage: { ...usage },
			settledAt: new Date().toISOString(),
		};
		await finishVideoJobBilling(row.id, settled);
	} catch (err) {
		log.error("videos", "failed to settle video job billing", {
			err,
			videoId: row.id,
		});
	}
}
