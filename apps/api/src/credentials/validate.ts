import type { Adapter } from "#adapters/types.ts";
import { GatewayError } from "#core/errors.ts";

/** Checks credentials an adapter will receive: its required fields, the base URL, its own rules. */
export function validateRequiredCredentials(
	adapter: Adapter,
	credentials: Record<string, unknown>,
): void {
	for (const key of adapter.credentials.required) {
		if (typeof credentials[key] !== "string" || credentials[key] === "") {
			throw new GatewayError({
				class: "bad_request",
				message: `Credential "${key}" is required`,
				param: `credentials.${key}`,
			});
		}
	}
	validateBaseUrl(credentials.baseUrl);
	adapter.validateCredentials?.(credentials);
}

/**
 * A base URL the gateway will send credentials to: an absolute http(s) URL with no userinfo, query
 * or fragment, all of which would leak or be silently dropped when paths are appended.
 */
function validateBaseUrl(value: unknown): void {
	if (value === undefined) {
		return;
	}
	const invalid = (message: string) =>
		new GatewayError({
			class: "bad_request",
			message,
			param: "credentials.baseUrl",
		});
	if (typeof value !== "string") {
		throw invalid("credentials.baseUrl must be a string");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw invalid("credentials.baseUrl must be an absolute URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw invalid("credentials.baseUrl must use http or https");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw invalid(
			"credentials.baseUrl cannot contain credentials, query parameters, or fragments",
		);
	}
}
