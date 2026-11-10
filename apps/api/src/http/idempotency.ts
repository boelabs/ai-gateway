import { ADMIN_JSON_BODY_MAX_BYTES, readBodyBytes } from "./body.ts";
import { type AppEnv, actorOf } from "#auth/types.ts";
import { GatewayError } from "#core/errors.ts";
import type { MiddlewareHandler } from "hono";
import { getAuth } from "#auth/middleware.ts";
import { createHash } from "node:crypto";

import {
	completeIdempotencyKey,
	releaseIdempotencyKey,
	claimIdempotencyKey,
	storedResponse,
} from "#db/repos/idempotency.ts";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_REPLAY_HEADER = "idempotent-replay";
/** Long enough to cover a retry loop or an operator coming back after a timeout; short enough to forget. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const MAX_KEY_LENGTH = 255;

/** The request, reduced to a value that changes whenever the request does. */
function fingerprint(body: Uint8Array, method: string, path: string): string {
	return createHash("sha256")
		.update(`${method}
${path}
`)
		.update(body)
		.digest("hex");
}

function replay(status: number, response: unknown): Response {
	const headers = new Headers({ [IDEMPOTENCY_REPLAY_HEADER]: "true" });
	if (response === null || response === undefined) {
		return new Response(null, { status, headers });
	}
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(response), { status, headers });
}

/**
 * `Idempotency-Key` support for the calls that create things.
 *
 * A dashboard that retries a create — a double-clicked button, a reconnect after a timeout — has no
 * way to tell "it worked and the answer was lost" from "it never happened", and guessing wrong means
 * two virtual keys where the operator asked for one. Sending the same key with the retry makes the
 * gateway answer that question: the first call's response comes back, and nothing is created twice.
 *
 * Opt-in by design. A request without the header behaves exactly as it did before.
 */
export function idempotencyMiddleware(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const key = c.req.header(IDEMPOTENCY_HEADER)?.trim();
		if (!key || c.req.method !== "POST") {
			return next();
		}
		if (key.length > MAX_KEY_LENGTH) {
			throw new GatewayError({
				class: "bad_request",
				code: "invalid_idempotency_key",
				message: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
				publicMessage: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
			});
		}

		// The one capped read of the body; the handler parses the same bytes from the context.
		const requestBody = await readBodyBytes(c, ADMIN_JSON_BODY_MAX_BYTES);
		const actor = actorOf(getAuth(c));
		const { path } = c.req;
		const print = fingerprint(requestBody, c.req.method, path);
		const claim = await claimIdempotencyKey({
			actor,
			key,
			method: c.req.method,
			path,
			fingerprint: print,
			expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
		});

		if (!claim.claimed) {
			const { existing } = claim;
			if (existing.fingerprint !== print) {
				throw new GatewayError({
					class: "bad_request",
					status: 409,
					code: "idempotency_key_reuse",
					message: `Idempotency-Key "${key}" was already used for a different request`,
					publicMessage:
						"This Idempotency-Key was already used for a different request. Use a new key.",
				});
			}
			if (existing.status === null) {
				throw new GatewayError({
					class: "bad_request",
					status: 409,
					code: "idempotency_key_in_progress",
					message: `Idempotency-Key "${key}" is still in progress`,
					publicMessage:
						"The first request with this Idempotency-Key is still running. Retry in a moment.",
				});
			}
			const stored = storedResponse(existing);
			if (!stored.readable) {
				// Replaying anything else would be a lie, and running the request again could create the
				// thing twice: the honest answer is that this key's outcome can no longer be told.
				throw new GatewayError({
					class: "bad_request",
					status: 409,
					code: "idempotency_response_unreadable",
					message: `Idempotency-Key "${key}" completed, but its response was encrypted with a key this gateway no longer has`,
					publicMessage:
						"The first request with this Idempotency-Key completed, but its response can no longer be read. Check whether it took effect before retrying with a new key.",
				});
			}
			return replay(existing.status, stored.body);
		}

		try {
			await next();
		} catch (error) {
			await releaseIdempotencyKey(actor, key).catch(() => undefined);
			throw error;
		}

		const { status } = c.res;
		// Only a success is worth replaying: a rejected body should be retried with the same key once
		// it is fixed, and a 500 may well succeed on the next attempt.
		if (status < 200 || status >= 300) {
			await releaseIdempotencyKey(actor, key).catch(() => undefined);
			return;
		}

		const text = await c.res.clone().text();
		let body: unknown = null;
		if (text !== "") {
			try {
				body = JSON.parse(text);
			} catch {
				// Every admin response is JSON or empty; anything else is not ours to replay, so the key
				// is given back rather than storing a body we cannot reproduce faithfully.
				await releaseIdempotencyKey(actor, key).catch(() => undefined);
				return;
			}
		}
		await completeIdempotencyKey(actor, key, status, body);
		c.res.headers.set(IDEMPOTENCY_REPLAY_HEADER, "false");
	};
}
