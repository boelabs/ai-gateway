import { ADAPTER_KEY_PATTERN, ADAPTER_KEY_RULE } from "#adapters/key.ts";
import { pageParams, uuidParam } from "./params.ts";
import { GatewayError } from "#core/errors.ts";
import { parseJsonBody } from "#http/body.ts";
import type { AppEnv } from "#auth/types.ts";
import { ok } from "#http/respond.ts";
import { Hono } from "hono";
import { z } from "zod/v4";

import {
	listProviderCredentialsPage,
	type ProviderCredentialRow,
	getProviderCredentialById,
	deleteProviderCredential,
} from "#db/repos/providerCredentials.ts";

import {
	createProviderCredential,
	updateSavedCredential,
} from "#credentials/service.ts";

const nameSchema = z.string().trim().min(1).max(120);

const credentialFieldsSchema = z
	.record(z.string(), z.unknown())
	.refine((credentials) => Object.keys(credentials).length > 0, {
		message: "credentials must include at least one field",
	});

export const createCredentialSchema = z
	.object({
		name: nameSchema,
		adapterKey: z
			.string()
			.min(1)
			.max(80)
			.regex(ADAPTER_KEY_PATTERN, ADAPTER_KEY_RULE)
			.optional(),
		credentials: credentialFieldsSchema.optional(),
		/** Saves the credentials an existing deployment already holds, without anyone retyping them. */
		fromDeploymentId: z.uuid().optional(),
	})
	.strict()
	.refine(
		(input) =>
			input.fromDeploymentId === undefined
				? input.adapterKey !== undefined && input.credentials !== undefined
				: input.adapterKey === undefined && input.credentials === undefined,
		{
			message:
				"send either adapterKey and credentials, or fromDeploymentId alone",
		},
	);

export const updateCredentialSchema = z
	.object({
		name: nameSchema.optional(),
		credentials: credentialFieldsSchema.optional(),
	})
	.strict()
	.refine(
		(input) => input.name !== undefined || input.credentials !== undefined,
		{ message: "send name, credentials, or both" },
	);

/** A saved credential as the API shows it: never the secret, only what recognizes it. */
function credentialView(row: ProviderCredentialRow) {
	return {
		id: row.id,
		name: row.name,
		adapterKey: row.adapterKey,
		fields: row.fields,
		hint: row.hint,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export const credentialsAdminApp = new Hono<AppEnv>();

credentialsAdminApp.get("/", async (c) => {
	const { limit, offset } = pageParams(c, { defaultLimit: 50, maxLimit: 200 });
	const adapterKey = c.req.query("adapterKey");
	const q = c.req.query("q");
	const result = await listProviderCredentialsPage({
		limit,
		offset,
		...(adapterKey ? { adapterKey } : {}),
		...(q ? { q } : {}),
	});
	return c.json({
		data: result.rows.map(credentialView),
		pagination: {
			limit,
			offset,
			total: result.total,
			nextOffset: offset + limit < result.total ? offset + limit : null,
		},
	});
});

credentialsAdminApp.post("/", async (c) => {
	const input = await parseJsonBody(c, createCredentialSchema);
	const row = await createProviderCredential(
		input.fromDeploymentId === undefined
			? {
					name: input.name,
					adapterKey: input.adapterKey ?? "",
					credentials: input.credentials ?? {},
				}
			: { name: input.name, fromDeploymentId: input.fromDeploymentId },
	);
	return ok(c, credentialView(row), 201);
});

credentialsAdminApp.get("/:id", async (c) => {
	const row = await getProviderCredentialById(uuidParam(c, "id", "Credential"));
	if (!row) {
		throw new GatewayError({
			class: "not_found",
			message: "Credential not found",
		});
	}
	return ok(c, credentialView(row));
});

credentialsAdminApp.patch("/:id", async (c) => {
	const input = await parseJsonBody(c, updateCredentialSchema);
	const row = await updateSavedCredential(uuidParam(c, "id", "Credential"), {
		...(input.name === undefined ? {} : { name: input.name }),
		...(input.credentials === undefined
			? {}
			: { credentials: input.credentials }),
	});
	return ok(c, credentialView(row));
});

/** Deployments filled from it keep their own copy, so deleting a credential never breaks one. */
credentialsAdminApp.delete("/:id", async (c) => {
	const deleted = await deleteProviderCredential(
		uuidParam(c, "id", "Credential"),
	);
	if (!deleted) {
		throw new GatewayError({
			class: "not_found",
			message: "Credential not found",
		});
	}
	return c.body(null, 204);
});
