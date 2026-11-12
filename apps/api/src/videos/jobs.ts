import { deleteExpiredVideoAssets, refreshDueVideoJobs } from "./service.ts";
import { purgeFinishedVideoRows } from "#db/repos/videos.ts";
import { reconcileVideoBilling } from "./billing.ts";
import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";

const VIDEO_ROW_RETENTION_MS = 7 * 24 * 60 * 60_000;

export function startVideoJobs(): () => void {
	let running = false;
	const run = async (): Promise<void> => {
		// Skip the tick if the previous one is still refreshing/downloading; job claiming
		// makes overlap safe across instances, but there is no point stacking local passes.
		if (running) {
			return;
		}
		running = true;
		try {
			await refreshDueVideoJobs().catch((err: unknown) => {
				log.error("videos", "poll job failed", { err });
			});
			await deleteExpiredVideoAssets()
				.then((deleted) => {
					if (deleted > 0) {
						log.info("videos", "deleted expired video assets", { deleted });
					}
				})
				.catch((err: unknown) => {
					log.error("videos", "asset gc failed", { err });
				});
			// Rows outlive their media by a week, long enough to answer late lookups and audits.
			await purgeFinishedVideoRows(
				new Date(Date.now() - VIDEO_ROW_RETENTION_MS),
			)
				.then((purged) => {
					if (purged > 0) {
						log.info("videos", "purged finished video rows", { purged });
					}
				})
				.catch((err: unknown) => {
					log.error("videos", "video row purge failed", { err });
				});
			await reconcileVideoBilling()
				.then((finished) => {
					if (finished > 0) {
						log.warn("videos", "finished stale video billing claims", {
							finished,
						});
					}
				})
				.catch((err: unknown) => {
					log.error("videos", "billing reconciliation failed", { err });
				});
		} finally {
			running = false;
		}
	};
	void run();
	const timer = setInterval(() => void run(), env.VIDEO_JOB_POLL_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
