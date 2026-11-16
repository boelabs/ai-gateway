import { and, asc, count, eq, ilike, sql, type SQL } from "drizzle-orm";
import { decryptRecord, encryptJson } from "#db/crypto.ts";
import { writtenRow } from "#db/returning.ts";
import { randomUUID } from "node:crypto";
import { db } from "#db/client.ts";

import {
	type ProviderCredentialHint,
	providerCredentials,
} from "#db/schema.ts";

export type ProviderCredentialRow = typeof providerCredentials.$inferSelect;

const PURPOSE = "provider-credential";

/** What an operator may see of a credential: the last characters of the key and the URL's host. */
export function credentialHint(
	credentials: Record<string, unknown>,
): ProviderCredentialHint {
	const hint: ProviderCredentialHint = {};
	const { apiKey, baseUrl } = credentials;
	// A short key would be mostly revealed by its last four characters.
	if (typeof apiKey === "string" && apiKey.length >= 16) {
		hint.apiKey = apiKey.slice(-4);
	}
	if (typeof baseUrl === "string") {
		try {
			hint.baseUrl = new URL(baseUrl).host;
		} catch {
			// Validated before it is stored; an unparsable value simply has no hint.
		}
	}
	return hint;
}

function sealed(id: string, credentials: Record<string, unknown>) {
	return {
		secret: encryptJson(credentials, PURPOSE, id),
		hint: credentialHint(credentials),
		fields: Object.keys(credentials).sort(),
	};
}

/** The decrypted fields of a saved credential. The ciphertext only opens on its own row. */
export function openProviderCredential(
	row: Pick<ProviderCredentialRow, "id" | "secret">,
): Record<string, unknown> {
	return decryptRecord(row.secret, PURPOSE, row.id);
}

export interface ProviderCredentialFilter {
	adapterKey?: string;
	q?: string;
}

export async function listProviderCredentialsPage(
	opts: { limit: number; offset: number } & ProviderCredentialFilter,
): Promise<{ rows: ProviderCredentialRow[]; total: number }> {
	const conds: SQL[] = [];
	if (opts.adapterKey) {
		conds.push(eq(providerCredentials.adapterKey, opts.adapterKey));
	}
	if (opts.q) {
		conds.push(ilike(providerCredentials.name, `%${opts.q}%`));
	}
	const where = conds.length > 0 ? and(...conds) : undefined;
	const [rows, totalRow] = await Promise.all([
		db
			.select()
			.from(providerCredentials)
			.where(where)
			.orderBy(asc(sql`lower(${providerCredentials.name})`))
			.limit(opts.limit)
			.offset(opts.offset),
		db.select({ value: count() }).from(providerCredentials).where(where),
	]);
	return { rows, total: Number(totalRow[0]?.value ?? 0) };
}

/** Every credential of one adapter: few rows, read to find a duplicate secret. */
export function listProviderCredentialsForAdapter(
	adapterKey: string,
): Promise<ProviderCredentialRow[]> {
	return db
		.select()
		.from(providerCredentials)
		.where(eq(providerCredentials.adapterKey, adapterKey));
}

export async function getProviderCredentialById(
	id: string,
): Promise<ProviderCredentialRow | undefined> {
	const [row] = await db
		.select()
		.from(providerCredentials)
		.where(eq(providerCredentials.id, id))
		.limit(1);
	return row;
}

export async function getProviderCredentialByName(
	name: string,
): Promise<ProviderCredentialRow | undefined> {
	const [row] = await db
		.select()
		.from(providerCredentials)
		.where(sql`lower(${providerCredentials.name}) = lower(${name})`)
		.limit(1);
	return row;
}

export async function insertProviderCredential(input: {
	name: string;
	adapterKey: string;
	credentials: Record<string, unknown>;
}): Promise<ProviderCredentialRow> {
	const id = randomUUID();
	const [row] = await db
		.insert(providerCredentials)
		.values({
			id,
			name: input.name,
			adapterKey: input.adapterKey,
			...sealed(id, input.credentials),
		})
		.returning();
	return writtenRow(row, "insertProviderCredential");
}

export async function updateProviderCredential(
	id: string,
	input: { name?: string; credentials?: Record<string, unknown> },
): Promise<ProviderCredentialRow | undefined> {
	const [row] = await db
		.update(providerCredentials)
		.set({
			updatedAt: new Date(),
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.credentials === undefined ? {} : sealed(id, input.credentials)),
		})
		.where(eq(providerCredentials.id, id))
		.returning();
	return row;
}

export async function deleteProviderCredential(id: string): Promise<boolean> {
	const rows = await db
		.delete(providerCredentials)
		.where(eq(providerCredentials.id, id))
		.returning({ id: providerCredentials.id });
	return rows.length > 0;
}
