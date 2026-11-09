import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "@boelabs/postgres";
import { env } from "#config/env.ts";

// TLS comes from the URL's `sslmode`, read as libpq does; without one the connection is plaintext.
export const sql = postgres(env.DATABASE_URL, {
	max: env.DATABASE_POOL_MAX,
	onnotice: () => {
		/* intentionally empty */
	},
});

export const db = drizzle(sql);

/** Health ping: SELECT 1. */
export async function pingDb(): Promise<boolean> {
	try {
		await sql`select 1`;
		return true;
	} catch {
		return false;
	}
}

export async function closeDb(timeoutSeconds = 5): Promise<void> {
	await sql.end({ timeout: timeoutSeconds });
}
