"use server";

import { createCredential, deleteCredential, updateCredential } from "./api.ts";
import type { CreateCredentialInput, UpdateCredentialInput } from "./common.ts";
import { attempt } from "#/shared/lib/action.ts";
import { revalidatePath } from "next/cache";

/**
 * Every write the credentials pages can make. Server Actions, so a pasted API key goes from this
 * process to the gateway and never into a request the browser composed.
 */
function revalidateCredentials() {
	revalidatePath("/credentials", "layout");
	// The deployment editor's picker lists them too.
	revalidatePath("/models", "layout");
}

export async function createCredentialAction(
	body: CreateCredentialInput,
	idempotencyKey?: string,
) {
	const result = await attempt(
		() => createCredential(body, idempotencyKey),
		"The credential could not be saved.",
	);
	if (result.ok) {
		revalidateCredentials();
	}
	return result;
}

export async function updateCredentialAction(
	id: string,
	body: UpdateCredentialInput,
) {
	const result = await attempt(
		() => updateCredential(id, body),
		"The credential could not be saved.",
	);
	if (result.ok) {
		revalidateCredentials();
	}
	return result;
}

export async function deleteCredentialAction(id: string) {
	const result = await attempt(
		() => deleteCredential(id),
		"The credential could not be deleted.",
	);
	if (result.ok) {
		revalidateCredentials();
	}
	return result;
}
