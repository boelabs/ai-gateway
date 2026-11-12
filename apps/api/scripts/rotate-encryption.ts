import { type SQL, and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { IDEMPOTENCY_PURPOSE } from "#db/repos/idempotency.ts";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { closeDb, db } from "#db/client.ts";

import {
	activeEncryptionKeyId,
	type EncEnvelope,
	decryptRecord,
	decryptString,
	decryptJson,
	encryptJson,
} from "#db/crypto.ts";

import {
	extensionArtifacts,
	modelDeployments,
	idempotencyKeys,
	payloadSamples,
	virtualKeys,
} from "#db/schema.ts";

const BATCH_SIZE = 100;

/** A row whose envelope the keyring cannot open: reported, never rewritten, never fatal. */
interface Orphan {
	table: string;
	id: string;
	error: string;
}

const orphans: Orphan[] = [];

interface Rotation {
	table: string;
	from: PgTable;
	id: PgColumn;
	envelope: PgColumn;
	/** Rows that still need resealing (besides the id cursor). */
	pending: SQL;
	/** Re-encrypts one envelope under the active key; throws when it cannot be opened. */
	reseal: (envelope: EncEnvelope) => unknown;
}

/**
 * Reseals every row of one table under the active key, a batch at a time. Walks by id, so a row
 * that cannot be opened is skipped (and reported) instead of being selected again forever or
 * aborting the whole rotation; an update only lands if the envelope is still the one that was read.
 */
async function rotate(rotation: Rotation): Promise<number> {
	let rotated = 0;
	let after: string | null = null;
	while (true) {
		const rows = (await db
			.select({ id: rotation.id, envelope: rotation.envelope })
			.from(rotation.from)
			.where(
				after === null
					? rotation.pending
					: and(rotation.pending, gt(rotation.id, after)),
			)
			.orderBy(asc(rotation.id))
			.limit(BATCH_SIZE)) as { id: string; envelope: EncEnvelope | null }[];
		const last = rows.at(-1);
		if (!last) {
			return rotated;
		}
		after = last.id;
		rotated += await db.transaction(async (tx) => {
			let updatedCount = 0;
			for (const row of rows) {
				if (row.envelope === null) {
					continue;
				}
				let resealed: unknown;
				try {
					resealed = rotation.reseal(row.envelope);
				} catch (error) {
					orphans.push({
						table: rotation.table,
						id: row.id,
						error: error instanceof Error ? error.message : String(error),
					});
					continue;
				}
				const updated = await tx
					.update(rotation.from)
					.set({ [rotation.envelope.name]: resealed } as never)
					.where(
						and(eq(rotation.id, row.id), eq(rotation.envelope, row.envelope)),
					)
					.returning({ id: rotation.id });
				updatedCount += updated.length;
			}
			return updatedCount;
		});
	}
}

function notActive(column: PgColumn): SQL {
	return sql`${column}->>'kid' IS DISTINCT FROM ${activeEncryptionKeyId()}`;
}

const ROTATIONS: Record<string, Rotation> = {
	deployments: {
		table: "model_deployments",
		from: modelDeployments,
		id: modelDeployments.id,
		envelope: modelDeployments.credentials,
		pending: notActive(modelDeployments.credentials),
		reseal: (envelope) =>
			encryptJson(
				decryptRecord(envelope, "deployment-credentials"),
				"deployment-credentials",
			),
	},
	extensions: {
		table: "extension_artifacts",
		from: extensionArtifacts,
		id: extensionArtifacts.id,
		envelope: extensionArtifacts.code,
		pending: notActive(extensionArtifacts.code),
		reseal: (envelope) =>
			encryptJson(
				decryptString(envelope, "extension-source"),
				"extension-source",
			),
	},
	payloadSamples: {
		table: "payload_samples",
		from: payloadSamples,
		id: payloadSamples.id,
		envelope: payloadSamples.envelope,
		pending: notActive(payloadSamples.envelope),
		reseal: (envelope) =>
			encryptJson(
				decryptJson(envelope, "observability-payload"),
				"observability-payload",
			),
	},
	/**
	 * Rows live a day, but a key retired within that day would leave their replays unreadable. Only
	 * sealed responses are selected: an empty body is NULL, and a row from before responses were
	 * sealed has no `kid` to rotate.
	 */
	idempotencyResponses: {
		table: "idempotency_keys",
		from: idempotencyKeys,
		id: idempotencyKeys.id,
		envelope: idempotencyKeys.response,
		pending: and(
			sql`${idempotencyKeys.response}->>'purpose' = ${IDEMPOTENCY_PURPOSE}`,
			notActive(idempotencyKeys.response),
		) as SQL,
		reseal: (envelope) =>
			encryptJson(
				decryptJson(envelope, IDEMPOTENCY_PURPOSE),
				IDEMPOTENCY_PURPOSE,
			),
	},
	// A private key has no envelope; NULL is distinct from every key id, so it is excluded.
	virtualKeys: {
		table: "virtual_keys",
		from: virtualKeys,
		id: virtualKeys.id,
		envelope: virtualKeys.secret,
		pending: and(
			isNotNull(virtualKeys.secret),
			notActive(virtualKeys.secret),
		) as SQL,
		reseal: (envelope) =>
			encryptJson(
				decryptString(envelope, "virtual-key-secret"),
				"virtual-key-secret",
			),
	},
};

async function run(): Promise<boolean> {
	const names = Object.keys(ROTATIONS);
	const counts = await Promise.all(
		names.map((name) => rotate(ROTATIONS[name] as Rotation)),
	);
	console.log(
		JSON.stringify({
			activeKeyId: activeEncryptionKeyId(),
			rotated: Object.fromEntries(names.map((name, i) => [name, counts[i]])),
			unreadable: orphans,
		}),
	);
	if (orphans.length > 0) {
		console.error(
			`${orphans.length} row(s) could not be decrypted with the keyring and were left as they are. Restore the key that sealed them, or remove the rows, then run the rotation again.`,
		);
	}
	return orphans.length === 0;
}

run()
	.then(async (clean) => {
		await closeDb();
		if (!clean) {
			process.exit(1);
		}
	})
	.catch(async (error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		try {
			await closeDb();
		} catch {
			// Already failing; a close error would only mask the rotation error above.
		}
		process.exit(1);
	});
