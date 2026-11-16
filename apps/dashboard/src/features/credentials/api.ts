import { api, unwrap } from "#/shared/api/client.ts";

import type {
	CreateCredentialInput,
	UpdateCredentialInput,
	SavedCredential,
} from "./common.ts";

export async function listCredentials(params?: {
	limit?: number;
	offset?: number;
	adapterKey?: string;
	q?: string;
}) {
	return unwrap(
		await api.GET("/admin/credentials", { params: { query: params } }),
	);
}

/**
 * Every saved credential, for the deployment editor's picker.
 *
 * Swallows its failure: the picker is a shortcut, not the form's subject. Without it the operator
 * still types the credentials, as before.
 */
export async function savedCredentials(): Promise<SavedCredential[]> {
	return listCredentials({ limit: 200 })
		.then((page) => page.data)
		.catch(() => []);
}

/** One credential, never its secret; `null` when no credential has that id. */
export async function getCredential(
	id: string,
): Promise<SavedCredential | null> {
	const result = await api.GET("/admin/credentials/{id}", {
		params: { path: { id } },
	});
	if (result.response.status === 404) {
		return null;
	}
	return unwrap(result).data;
}

export async function createCredential(
	body: CreateCredentialInput,
	idempotencyKey?: string,
): Promise<SavedCredential> {
	return unwrap(
		await api.POST("/admin/credentials", {
			body,
			...(idempotencyKey
				? { headers: { "Idempotency-Key": idempotencyKey } }
				: {}),
		}),
	).data;
}

export async function updateCredential(
	id: string,
	body: UpdateCredentialInput,
): Promise<SavedCredential> {
	return unwrap(
		await api.PATCH("/admin/credentials/{id}", {
			params: { path: { id } },
			body,
		}),
	).data;
}

export async function deleteCredential(id: string): Promise<void> {
	const result = await api.DELETE("/admin/credentials/{id}", {
		params: { path: { id } },
	});
	if (result.error !== undefined) {
		unwrap(result);
	}
}
