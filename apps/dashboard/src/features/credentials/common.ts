import { parseObject } from "#/features/deployments/custom-model.ts";
import type { components } from "#/shared/api/schema";

/**
 * The saved-credential vocabulary, in a module with no server import: the table, the forms and the
 * deployment editor need it on both sides of the client/server boundary.
 */
export type SavedCredential = components["schemas"]["ProviderCredential"];
export type CreateCredentialInput =
	components["schemas"]["CreateProviderCredential"];
export type UpdateCredentialInput =
	components["schemas"]["UpdateProviderCredential"];

/** Human labels for the credential fields adapters ask for; anything else shows its own name. */
export const CREDENTIAL_LABELS: Record<string, string> = {
	apiKey: "API key",
	baseUrl: "Base URL",
};

/** What recognizes a credential without revealing it: `…mnop · example.com`. */
export function credentialHint(credential: SavedCredential): string | null {
	const parts = [
		credential.hint.apiKey ? `…${credential.hint.apiKey}` : null,
		credential.hint.baseUrl ?? null,
	].filter((part): part is string => part !== null);
	return parts.length > 0 ? parts.join(" · ") : null;
}

/** Deleting one never touches a model: each deployment keeps its own copy of what it was filled with. */
export const DELETE_CREDENTIAL_DESCRIPTION =
	"Models filled from it keep working with their own copy. It is only no longer offered when creating one.";

/** The table's headers, shared with the page's skeleton (a Server Component). */
export const CREDENTIAL_HEADERS = [
	"Name",
	"Adapter",
	"Key",
	"Updated",
	"",
] as const;

/**
 * The credential fields a form typed: one input per field the adapter requires (`cred_<field>`) and
 * the optional JSON of extra fields. Blank inputs are left out, so an editor keeps what is stored.
 */
export function readCredentialFields(
	form: FormData,
	required: readonly string[],
): Record<string, unknown> {
	const credentials: Record<string, unknown> = {};
	for (const field of required) {
		const value = String(form.get(`cred_${field}`) ?? "").trim();
		if (value) {
			credentials[field] = value;
		}
	}
	const extra = parseObject(
		String(form.get("credentialsExtra") ?? ""),
		"Extra credentials",
	);
	return extra ? { ...credentials, ...extra } : credentials;
}
