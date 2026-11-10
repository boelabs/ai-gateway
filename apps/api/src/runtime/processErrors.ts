import { recordUnhandledRejection } from "#telemetry/index.ts";
import { lifecyclePhase } from "#runtime/lifecycle.ts";
import { log } from "#logging/log.ts";

/**
 * Last line of defence for promise rejections nobody handled. Bun terminates the process on one by
 * default, which turns a single bug in a background write into an outage for every open stream. The
 * gateway logs it with its full context, counts it, and keeps serving. This does not make such a
 * rejection acceptable: each source is still a bug to fix where it starts.
 */
export function onUnhandledRejection(reason: unknown): void {
	recordUnhandledRejection();
	log.error("process", "unhandled promise rejection", {
		err: reason,
		lifecycle: lifecyclePhase(),
	});
}

let installed = false;

export function installProcessErrorHandlers(): void {
	if (installed) {
		return;
	}
	installed = true;
	process.on("unhandledRejection", onUnhandledRejection);
}
