import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readdir, readFile } from "node:fs/promises";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "@boelabs/postgres";
import { env } from "#config/env.ts";
import { join } from "node:path";

/**
 * Applies pending migrations, safely enough to run from every replica's boot and against a busy
 * production database.
 *
 * Drizzle's migrator takes no lock of its own, so a Postgres advisory lock serialises replicas: the
 * second waits for the first, then finds nothing pending. The wait is bounded, so a wedged holder
 * fails a boot instead of hanging it.
 *
 * DDL runs on a dedicated connection with `lock_timeout` set: an `ALTER TABLE` that queues behind a
 * long transaction would otherwise block every query on that table while it waits. Timing out and
 * retrying a few times with backoff lets traffic through between tries. `statement_timeout` is
 * generous, for real work such as backfills, but finite.
 *
 * Indexes on large tables cannot be built inside the migrator's transaction without locking writes
 * for the whole build. They live in `migrations-concurrent/`, one `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` per file, applied in name order after the regular migrations under the same lock and
 * recorded in `drizzle.__concurrent_indexes`. A build that died leaves an INVALID index behind; it is
 * dropped and built again. These indexes are deliberately not declared in `schema.ts`, so drizzle-kit
 * never emits a blocking copy of them.
 *
 * Migrations are tracked in `drizzle.__drizzle_migrations` and generated from `schema.ts` with
 * `bun run db:generate`. Once applied, a migration is immutable and a correction ships as a new one.
 */
const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");
const CONCURRENT_DIR = join(import.meta.dirname, "migrations-concurrent");

/** Arbitrary, but shared with every release that migrates (a rollout runs two), so never change it. */
const MIGRATION_LOCK_ID = 918_273_645;
const MIGRATION_LOCK_WAIT_MS = 10 * 60_000;
/** Milliseconds, as Postgres reads a bare number for these settings. */
const LOCK_TIMEOUT_MS = 5000;
const STATEMENT_TIMEOUT_MS = 30 * 60_000;
const LOCK_RETRY_DELAYS_MS = [1000, 3000, 10_000, 30_000];

type Sql = ReturnType<typeof postgres>;

function isLockTimeout(error: unknown): boolean {
	return (error as { code?: string } | null)?.code === "55P03";
}

async function retryingLockTimeouts<T>(step: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await step();
		} catch (error) {
			const delay = LOCK_RETRY_DELAYS_MS[attempt];
			if (!isLockTimeout(error) || delay === undefined) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

const CONCURRENT_INDEX =
	/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?([a-z0-9_]+)"?/iu;

/** The file's index name, or an error: the track only takes concurrent, idempotent index builds. */
export function concurrentIndexName(file: string, statement: string): string {
	const match = CONCURRENT_INDEX.exec(statement);
	const name = match?.[1];
	if (!name || statement.trim().replace(/;\s*$/u, "").includes(";")) {
		throw new Error(
			`${file} must hold exactly one CREATE INDEX CONCURRENTLY IF NOT EXISTS statement`,
		);
	}
	return name;
}

async function applyConcurrentIndexes(client: Sql): Promise<void> {
	let files: string[];
	try {
		files = (await readdir(CONCURRENT_DIR))
			.filter((file) => file.endsWith(".sql"))
			.sort();
	} catch {
		return;
	}
	await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
	await client`
		CREATE TABLE IF NOT EXISTS drizzle.__concurrent_indexes (
			name text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`;
	const applied = new Set(
		(
			await client<
				{ name: string }[]
			>`SELECT name FROM drizzle.__concurrent_indexes`
		).map((row) => row.name),
	);
	for (const file of files) {
		if (applied.has(file)) {
			continue;
		}
		const statement = await readFile(join(CONCURRENT_DIR, file), "utf8");
		const index = concurrentIndexName(file, statement);
		await retryingLockTimeouts(async () => {
			// A concurrent build that was interrupted leaves an INVALID index that IF NOT EXISTS would
			// then skip forever; drop it and build again.
			const [invalid] = await client`
				SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relname = ${index} AND NOT i.indisvalid`;
			if (invalid) {
				await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
			}
			await client.unsafe(statement);
		});
		await client`INSERT INTO drizzle.__concurrent_indexes (name) VALUES (${file})`;
	}
}

export async function runMigrations(): Promise<void> {
	const client = postgres(env.DATABASE_URL, {
		max: 2,
		onnotice: () => {
			/* intentionally empty */
		},
		connection: {
			application_name: "ai-gateway-migrate",
			lock_timeout: LOCK_TIMEOUT_MS,
			statement_timeout: STATEMENT_TIMEOUT_MS,
		},
	});
	try {
		await client.lock(
			MIGRATION_LOCK_ID,
			async () => {
				await retryingLockTimeouts(() =>
					migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR }),
				);
				await applyConcurrentIndexes(client);
			},
			{ signal: AbortSignal.timeout(MIGRATION_LOCK_WAIT_MS) },
		);
	} finally {
		await client.end({ timeout: 5 });
	}
}
