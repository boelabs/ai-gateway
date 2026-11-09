import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client.ts";
import { join } from "node:path";

/**
 * Applies pending Drizzle migrations, safely enough to run from every replica's boot.
 *
 * Drizzle's migrator takes no lock of its own: it reads the last applied migration, works out what
 * is pending, and applies it. Two processes starting together therefore read the same state and try
 * to apply the same DDL, and the loser fails on a relation that now already exists. A Postgres
 * advisory lock serialises them — the second waits for the first, then finds nothing pending and
 * returns immediately.
 *
 * Migrations are tracked in `drizzle.__drizzle_migrations` and generated from `schema.ts` with
 * `bun run db:generate`. Applying them is idempotent; once applied, a migration is immutable and a
 * correction ships as a new one.
 */
const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Arbitrary, but shared with every release that migrates (a rollout runs two), so never change it. */
const MIGRATION_LOCK_ID = 918_273_645;

export async function runMigrations(): Promise<void> {
	await sql.lock(MIGRATION_LOCK_ID, () =>
		migrate(db, { migrationsFolder: MIGRATIONS_DIR }),
	);
}
