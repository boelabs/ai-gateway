import type { ObjectStore, StoredObject } from "./objects.ts";
import { GatewayError } from "#core/errors.ts";

function notConfigured(): GatewayError {
	return new GatewayError({
		class: "server",
		status: 503,
		code: "object_storage_not_configured",
		message: "Object storage is not configured",
		publicMessage: "Object storage is not configured for this gateway.",
	});
}

/** Every call rejects, as the `async` methods it replaces did: callers see a promise, never a throw. */
export class DisabledObjectStore implements ObjectStore {
	readonly backend = "disabled" as const;

	put(): Promise<{ etag?: string }> {
		return Promise.reject(notConfigured());
	}

	get(): Promise<StoredObject> {
		return Promise.reject(notConfigured());
	}

	head(): Promise<Omit<StoredObject, "body">> {
		return Promise.reject(notConfigured());
	}

	delete(): Promise<void> {
		return Promise.reject(notConfigured());
	}
}
