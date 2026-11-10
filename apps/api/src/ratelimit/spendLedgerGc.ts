import { pruneSpendLedger } from "#db/repos/virtualKeys.ts";
import { log } from "#logging/log.ts";

const INTERVAL_MS = 3_600_000;
/** Ledger rows only guard spend-write retries and billing reconciliation, which finish in minutes. */
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_BATCHES_PER_RUN = 100;

/** In-process GC for `spend_ledger`, batched so one run never holds a long delete. */
export function startSpendLedgerGcJob(): () => void {
	let running = false;
	const run = async (): Promise<void> => {
		if (running) {
			return;
		}
		running = true;
		try {
			const before = new Date(Date.now() - RETENTION_MS);
			let deleted = 0;
			for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
				const count = await pruneSpendLedger(before);
				deleted += count;
				if (count === 0) {
					break;
				}
			}
			if (deleted > 0) {
				log.info("spend-ledger", "gc deleted old entries", { deleted });
			}
		} catch (err) {
			log.error("spend-ledger", "gc failed", { err });
		} finally {
			running = false;
		}
	};
	void run();
	const timer = setInterval(() => void run(), INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
