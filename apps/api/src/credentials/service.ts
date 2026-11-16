import { validateRequiredCredentials } from "#credentials/validate.ts";
import { getDeploymentById } from "#db/repos/deployments.ts";
import { getAdapter } from "#adapters/registry.ts";
import type { Adapter } from "#adapters/types.ts";
import { GatewayError } from "#core/errors.ts";
import { decryptRecord } from "#db/crypto.ts";

import {
	listProviderCredentialsForAdapter,
	getProviderCredentialByName,
	type ProviderCredentialRow,
	getProviderCredentialById,
	insertProviderCredential,
	updateProviderCredential,
	openProviderCredential,
} from "#db/repos/providerCredentials.ts";

/**
 * Saved provider credentials. They only fill a deployment's credentials when it is created or edited:
 * the deployment keeps its own copy, so nothing here is read while routing, and deleting either side
 * leaves the other untouched.
 */

export type CreateProviderCredentialInput = { name: string } & (
	| { adapterKey: string; credentials: Record<string, unknown> }
	| { fromDeploymentId: string }
);

export interface UpdateProviderCredentialInput {
	name?: string;
	/** Merged over the stored fields; `null` removes one. */
	credentials?: Record<string, unknown>;
}

function requireAdapter(adapterKey: string): Adapter {
	const adapter = getAdapter(adapterKey);
	if (!adapter) {
		throw new GatewayError({
			class: "bad_request",
			message: `Adapter "${adapterKey}" is not registered`,
			param: "adapterKey",
		});
	}
	return adapter;
}

async function requireCredential(id: string): Promise<ProviderCredentialRow> {
	const row = await getProviderCredentialById(id);
	if (!row) {
		throw new GatewayError({
			class: "not_found",
			message: `Credential "${id}" does not exist`,
		});
	}
	return row;
}

async function assertNameFree(name: string, exceptId?: string): Promise<void> {
	const existing = await getProviderCredentialByName(name);
	if (existing && existing.id !== exceptId) {
		throw new GatewayError({
			class: "bad_request",
			code: "credential_name_taken",
			message: `A credential named "${existing.name}" already exists`,
			param: "name",
		});
	}
}

/** Same fields, same values, regardless of key order. */
function sameCredentials(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	const canonical = (value: Record<string, unknown>) =>
		JSON.stringify(
			Object.keys(value)
				.sort()
				.map((key) => [key, value[key]]),
		);
	return canonical(a) === canonical(b);
}

/**
 * Saving the same secret twice under two names is how a rotation later misses one of them, so the
 * second save is refused and names the first.
 */
async function assertNotSaved(
	adapterKey: string,
	credentials: Record<string, unknown>,
	exceptId?: string,
): Promise<void> {
	for (const row of await listProviderCredentialsForAdapter(adapterKey)) {
		if (row.id === exceptId) {
			continue;
		}
		let stored: Record<string, unknown>;
		try {
			stored = openProviderCredential(row);
		} catch {
			continue;
		}
		if (sameCredentials(stored, credentials)) {
			throw new GatewayError({
				class: "bad_request",
				code: "credential_duplicate",
				message: `These credentials are already saved as "${row.name}"`,
				param: "credentials",
			});
		}
	}
}

/** A concurrent save of the same name loses to the unique index; it reads like the pre-check. */
function isUniqueViolation(error: unknown): boolean {
	const code = (value: unknown) =>
		value && typeof value === "object" && "code" in value
			? (value as { code?: unknown }).code
			: undefined;
	return (
		code(error) === "23505" ||
		code((error as { cause?: unknown } | null)?.cause) === "23505"
	);
}

async function nameGuarded<T>(name: string, write: () => Promise<T>) {
	try {
		return await write();
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw new GatewayError({
				class: "bad_request",
				code: "credential_name_taken",
				message: `A credential named "${name}" already exists`,
				param: "name",
			});
		}
		throw error;
	}
}

export async function createProviderCredential(
	input: CreateProviderCredentialInput,
): Promise<ProviderCredentialRow> {
	let adapterKey: string;
	let credentials: Record<string, unknown>;
	if ("fromDeploymentId" in input) {
		const deployment = await getDeploymentById(input.fromDeploymentId);
		if (!deployment) {
			throw new GatewayError({
				class: "bad_request",
				message: `Deployment "${input.fromDeploymentId}" does not exist`,
				param: "fromDeploymentId",
			});
		}
		({ adapterKey } = deployment);
		credentials = decryptRecord(
			deployment.credentials,
			"deployment-credentials",
		);
	} else {
		({ adapterKey, credentials } = input);
	}
	validateRequiredCredentials(requireAdapter(adapterKey), credentials);
	await assertNameFree(input.name);
	await assertNotSaved(adapterKey, credentials);
	return nameGuarded(input.name, () =>
		insertProviderCredential({ name: input.name, adapterKey, credentials }),
	);
}

export async function updateSavedCredential(
	id: string,
	patch: UpdateProviderCredentialInput,
): Promise<ProviderCredentialRow> {
	const existing = await requireCredential(id);
	let credentials: Record<string, unknown> | undefined;
	if (patch.credentials !== undefined) {
		credentials = { ...openProviderCredential(existing) };
		for (const [field, value] of Object.entries(patch.credentials)) {
			if (value === null) {
				delete credentials[field];
			} else {
				credentials[field] = value;
			}
		}
		validateRequiredCredentials(
			requireAdapter(existing.adapterKey),
			credentials,
		);
		await assertNotSaved(existing.adapterKey, credentials, id);
	}
	if (patch.name !== undefined) {
		await assertNameFree(patch.name, id);
	}
	const row = await nameGuarded(patch.name ?? existing.name, () =>
		updateProviderCredential(id, {
			...(patch.name === undefined ? {} : { name: patch.name }),
			...(credentials === undefined ? {} : { credentials }),
		}),
	);
	if (!row) {
		throw new GatewayError({
			class: "not_found",
			message: `Credential "${id}" does not exist`,
		});
	}
	return row;
}

/**
 * The fields a saved credential fills into a deployment of `adapterKey`. A credential of another
 * adapter has other fields, so it is refused rather than half-applied.
 */
export async function savedCredentialFields(
	id: string,
	adapterKey: string,
): Promise<Record<string, unknown>> {
	const row = await getProviderCredentialById(id);
	if (!row) {
		throw new GatewayError({
			class: "bad_request",
			message: `Credential "${id}" does not exist`,
			param: "credentialId",
		});
	}
	if (row.adapterKey !== adapterKey) {
		throw new GatewayError({
			class: "bad_request",
			message: `Credential "${row.name}" belongs to adapter "${row.adapterKey}", not "${adapterKey}"`,
			param: "credentialId",
		});
	}
	return openProviderCredential(row);
}
