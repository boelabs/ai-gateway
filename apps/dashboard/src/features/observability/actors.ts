/**
 * How an actor reads in a table or a chart. Usage is grouped by actor strings like
 * `key:3f2a9c1e-…` or `user:alice`; a key's name, when the page could load it, beats its id.
 * Pure, so Server and Client Components can both use it.
 */
export function actorName(
	actor: string | null,
	keyNames: Readonly<Record<string, string>> = {},
): string {
	if (!actor) {
		return "—";
	}
	const separator = actor.indexOf(":");
	if (separator === -1) {
		return actor;
	}
	const kind = actor.slice(0, separator);
	const id = actor.slice(separator + 1);
	if (kind === "key") {
		return keyNames[id] ?? `key ${id.slice(0, 8)}`;
	}
	return id || actor;
}

/** `true` when the actor is an API key rather than an operator. */
export function isKeyActor(actor: string | null): boolean {
	return actor?.startsWith("key:") ?? false;
}
