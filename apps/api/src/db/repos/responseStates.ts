import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, sql as postgresClient } from "#db/client.ts";
import type { StateScope } from "#auth/scope.ts";
import { responseStates } from "#db/schema.ts";
import { writtenRow } from "#db/returning.ts";
import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";

export type ResponseStateRow = typeof responseStates.$inferSelect;

export interface StoreResponseStateInput {
	id: string;
	scope: StateScope;
	publicModel: string;
	deploymentId: string | null;
	adapterKey: string | null;
	previousResponseId: string | null;
	store?: boolean;
	requestInput: Record<string, unknown>[];
	output: Record<string, unknown>[];
	response: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

function responseStateExpiresAt(now = new Date()): Date {
	return new Date(
		now.getTime() + env.RESPONSES_STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	);
}

const GC_BATCH = 1000;
const GC_MAX_BATCHES = 100;
/** Shared by every replica, so one of them collects at a time. Never change it. */
const GC_LOCK_ID = 918_273_647;

/**
 * Deletes expired rows in batches (oldest expiry first) until a short batch or the per-run bound,
 * so one run never holds a long delete. Returns rows removed.
 */
export async function deleteExpiredResponseStates(
	now = new Date(),
): Promise<number> {
	let deleted = 0;
	for (let batch = 0; batch < GC_MAX_BATCHES; batch += 1) {
		const rows = await db.execute(sql`
			DELETE FROM ${responseStates}
			WHERE ${responseStates.id} IN (
				SELECT ${responseStates.id} FROM ${responseStates}
				WHERE ${responseStates.expiresAt} <= ${now.toISOString()}::timestamptz
				ORDER BY ${responseStates.expiresAt}
				LIMIT ${GC_BATCH}
			)
			RETURNING ${responseStates.id}`);
		deleted += rows.length;
		if (rows.length < GC_BATCH) {
			break;
		}
	}
	return deleted;
}

/**
 * Traffic-independent GC on a fixed interval, off the request path. Only the replica holding the GC
 * advisory lock runs a pass, and the next pass is scheduled when this one ends, so passes never
 * overlap. Returns a stop function.
 */
export function startResponseStateGcJob(): () => void {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const pass = async () => {
		try {
			const deleted = await postgresClient.lock(
				GC_LOCK_ID,
				() => deleteExpiredResponseStates(new Date()),
				{ wait: false },
			);
			if (deleted > 0) {
				log.info("response-states", "gc deleted expired rows", { deleted });
			}
		} catch (err) {
			if ((err as { code?: string }).code !== "LOCK_NOT_AVAILABLE") {
				log.error("response-states", "gc failed", { err });
			}
		} finally {
			if (!stopped) {
				timer = setTimeout(
					() => void pass(),
					env.RESPONSE_STATE_GC_INTERVAL_MS,
				);
				timer.unref();
			}
		}
	};
	void pass();
	return () => {
		stopped = true;
		clearTimeout(timer);
	};
}

/** Rows a scope owns. The master scope is what neither a key nor an operator session claims. */
function scopeCondition(scope: StateScope) {
	if (scope.virtualKeyId !== null) {
		return eq(responseStates.virtualKeyId, scope.virtualKeyId);
	}
	if (scope.ownerActor !== null) {
		return and(
			isNull(responseStates.virtualKeyId),
			eq(responseStates.ownerActor, scope.ownerActor),
		);
	}
	return and(
		isNull(responseStates.virtualKeyId),
		isNull(responseStates.ownerActor),
	);
}

export async function storeResponseState(
	input: StoreResponseStateInput,
): Promise<ResponseStateRow> {
	const [row] = await db
		.insert(responseStates)
		.values({
			id: input.id,
			virtualKeyId: input.scope.virtualKeyId,
			ownerActor: input.scope.ownerActor,
			publicModel: input.publicModel,
			deploymentId: input.deploymentId,
			adapterKey: input.adapterKey,
			previousResponseId: input.previousResponseId,
			store: input.store ?? true,
			requestInput: input.requestInput,
			output: input.output,
			response: input.response,
			metadata: input.metadata ?? {},
			expiresAt: responseStateExpiresAt(),
		})
		.returning();
	return writtenRow(row, "storeResponseState");
}

export async function getResponseStateForScope(
	id: string,
	scope: StateScope,
	now = new Date(),
): Promise<ResponseStateRow | undefined> {
	const where = scopeCondition(scope);
	const [row] = await db
		.select()
		.from(responseStates)
		.where(
			and(
				eq(responseStates.id, id),
				where,
				eq(responseStates.store, true),
				gt(responseStates.expiresAt, now),
			),
		)
		.limit(1);
	return row;
}

/**
 * Find a single stored response *item* by its id, within the key's scope. Faithful to OpenAI: an
 * `item_reference` may point to ANY stored item (when store=true), not only items chained via
 * `previous_response_id`. Searches both the stored output and the (already-expanded) request input.
 *
 * Rows are narrowed by the indexed `virtual_key_id` + `expires_at`; the jsonb containment recheck
 * then runs over that (typically small) set. If a single key accumulates a very large number of
 * stored states, add an expression GIN index over the item ids.
 */
export async function findResponseItemByIdForScope(
	itemId: string,
	scope: StateScope,
	now = new Date(),
): Promise<Record<string, unknown> | undefined> {
	const where = scopeCondition(scope);
	const needle = JSON.stringify([{ id: itemId }]);
	const [row] = await db
		.select({
			output: responseStates.output,
			requestInput: responseStates.requestInput,
		})
		.from(responseStates)
		.where(
			and(
				where,
				eq(responseStates.store, true),
				gt(responseStates.expiresAt, now),
				sql`(${responseStates.output} @> ${needle}::jsonb OR ${responseStates.requestInput} @> ${needle}::jsonb)`,
			),
		)
		.limit(1);
	if (!row) {
		return undefined;
	}
	return [...row.output, ...row.requestInput].find(
		(it) => (it as { id?: unknown }).id === itemId,
	);
}

/** Deletes a state within the key's scope. Returns true if it existed and was deleted. */
export async function deleteResponseStateForScope(
	id: string,
	scope: StateScope,
): Promise<boolean> {
	const where = scopeCondition(scope);
	const rows = await db
		.delete(responseStates)
		.where(
			and(eq(responseStates.id, id), where, eq(responseStates.store, true)),
		)
		.returning({ id: responseStates.id });
	return rows.length > 0;
}
