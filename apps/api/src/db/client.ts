import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "@boelabs/postgres";
import { env } from "#config/env.ts";

/** An idle connection is closed after this, so a quiet replica does not pin server connections. */
const IDLE_CONNECTION_SECONDS = 60;
/** A transaction left open this long without a statement is ended by the server. */
const IDLE_IN_TRANSACTION_MS = 60_000;
const ANALYTICS_POOL_MAX = 4;
const ANALYTICS_STATEMENT_TIMEOUT_MS = 120_000;
const HEALTH_PING_TIMEOUT_MS = 2000;

function client(max: number, statementTimeoutMs: number, name: string) {
	// TLS comes from the URL's `sslmode`, read as libpq does; without one the connection is plaintext.
	return postgres(env.DATABASE_URL, {
		max,
		idle_timeout: IDLE_CONNECTION_SECONDS,
		onnotice: () => {
			/* intentionally empty */
		},
		connection: {
			application_name: name,
			statement_timeout: statementTimeoutMs,
			idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_MS,
		},
	});
}

/** The request path and background jobs. */
export const sql = client(
	env.DATABASE_POOL_MAX,
	env.DATABASE_STATEMENT_TIMEOUT_MS,
	"ai-gateway",
);

export const db = drizzle(sql);

/**
 * Admin lists and analytics: few connections and a longer limit, so a slow report waits for its own
 * pool instead of taking connections inference needs.
 */
const analyticsSql = client(
	ANALYTICS_POOL_MAX,
	ANALYTICS_STATEMENT_TIMEOUT_MS,
	"ai-gateway-analytics",
);

export const analyticsDb = drizzle(analyticsSql);

/** Health ping: SELECT 1, answered within two seconds or reported down. */
export async function pingDb(): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			sql`select 1`.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), HEALTH_PING_TIMEOUT_MS);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function closeDb(timeoutSeconds = 5): Promise<void> {
	await Promise.all([
		sql.end({ timeout: timeoutSeconds }),
		analyticsSql.end({ timeout: timeoutSeconds }),
	]);
}
