import type { components } from "#/shared/api/schema";

/**
 * The operator vocabulary, in a module with no runtime weight at all — `schema` is a `.d.ts`.
 *
 * Client components need these types (the shell decides what to render from the permission list),
 * and `features/auth/api.ts` cannot give them one: it reads cookies through `next/headers` and would
 * drag the server into the browser bundle.
 */
export type OperatorIdentity = components["schemas"]["OperatorIdentity"];
export type Permission = components["schemas"]["Permission"];
export type Role = OperatorIdentity["user"]["role"];

const SAME_ORIGIN = "http://dashboard.invalid";

/**
 * Where to go after signing in, as a path on this dashboard, or `/`. Parsed rather than pattern-
 * matched: browsers read `/\evil.example` and `/%09/evil.example` as other hosts, so the value must
 * resolve against this origin and stay on it, and only its re-serialised path and query are kept.
 */
export function safeNextPath(next: unknown): string {
	if (
		typeof next !== "string" ||
		!next.startsWith("/") ||
		next.includes("\\") ||
		[...next].some((char) => {
			const code = char.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	) {
		return "/";
	}
	let url: URL;
	try {
		url = new URL(next, SAME_ORIGIN);
	} catch {
		return "/";
	}
	return url.origin === SAME_ORIGIN ? `${url.pathname}${url.search}` : "/";
}
