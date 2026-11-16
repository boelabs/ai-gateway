import { redis } from "#cache/redis.ts";

/**
 * Which deployment a GPT-Live session lives on, and who opened it. A session id is the provider's
 * (`live_…`), so attaching to it, forking it or downloading its recording must reach the same
 * deployment, and only for the key that opened it.
 */
export interface LiveSessionRecord {
	deploymentId: string;
	/** The opening key's scope: a virtual key id, or "master". */
	scopeKey: string;
	publicModel: string;
	upstreamModel: string;
}

/** A running session can be attached to or forked for this long. */
const RUNNING_TTL_SECONDS = 4 * 60 * 60;
/** OpenAI keeps a stored session's recording for 30 days. */
const STORED_TTL_SECONDS = 31 * 24 * 60 * 60;

function storageKey(sessionId: string): string {
	return `livesession:${sessionId}`;
}

export async function rememberLiveSession(
	sessionId: string,
	record: LiveSessionRecord,
	stored: boolean,
): Promise<void> {
	await redis.set(
		storageKey(sessionId),
		JSON.stringify(record),
		"EX",
		stored ? STORED_TTL_SECONDS : RUNNING_TTL_SECONDS,
	);
}

export async function liveSessionRecord(
	sessionId: string,
): Promise<LiveSessionRecord | null> {
	const raw = await redis.get(storageKey(sessionId));
	return raw === null ? null : (JSON.parse(raw) as LiveSessionRecord);
}
