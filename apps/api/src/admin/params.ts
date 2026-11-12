import { GatewayError } from "#core/errors.ts";
import type { Context } from "hono";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Whether an id could name a row keyed by UUID; anything else names nothing. */
export function isUuid(value: string): boolean {
	return UUID.test(value);
}

function integerQuery(
	c: Context,
	name: string,
	fallback: number,
	minimum: number,
): number {
	const raw = c.req.query(name);
	if (raw === undefined || raw === "") {
		return fallback;
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new GatewayError({
			class: "bad_request",
			code: "invalid_pagination",
			param: name,
			message: `${name} must be an integer of at least ${minimum}`,
			publicMessage: `${name} must be an integer of at least ${minimum}.`,
		});
	}
	return value;
}

/**
 * `limit` and `offset` of a list route. A value that is not a whole number is the caller's error
 * (400), not something to coerce into a database error; a limit above the maximum is clamped.
 */
export function pageParams(
	c: Context,
	options: { defaultLimit: number; maxLimit: number },
): { limit: number; offset: number } {
	return {
		limit: Math.min(
			integerQuery(c, "limit", options.defaultLimit, 1),
			options.maxLimit,
		),
		offset: integerQuery(c, "offset", 0, 0),
	};
}

/** A UUID path parameter, or 404: a malformed id names no row, and must not reach Postgres. */
export function uuidParam(c: Context, name: string, what: string): string {
	const value = c.req.param(name) ?? "";
	if (!isUuid(value)) {
		throw new GatewayError({
			class: "not_found",
			message: `${what} "${value}" does not exist`,
		});
	}
	return value;
}
