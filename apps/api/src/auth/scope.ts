import { type Auth, actorOf } from "./types.ts";
import { GatewayError } from "#core/errors.ts";

/**
 * Checks that the credential may use a public model.
 *  - master: everything.
 *  - session: everything its role can reach; model scoping is a property of issued keys, not of
 *    operators, and an operator can read the whole catalog from /admin anyway.
 *  - virtual with allowedModels=[]: everything.
 *  - virtual with allowedModels=[...]: only the listed ones.
 * Throws GatewayError(permission) otherwise.
 */
export function assertModelAllowed(auth: Auth, publicModel: string): void {
	if (auth.type === "master" || auth.type === "session") {
		return;
	}
	const allowed = auth.key.allowedModels;
	if (allowed.length === 0) {
		return;
	}
	if (!allowed.includes(publicModel)) {
		throw new GatewayError({
			class: "permission",
			message: `The API key does not have access to public model "${publicModel}"`,
		});
	}
}

/**
 * Who owns stored state (stored responses, video jobs). A virtual key owns its own; an operator
 * session owns its user's, apart from the master key and from other operators; the master key owns
 * what neither scope claims.
 */
export interface StateScope {
	virtualKeyId: string | null;
	ownerActor: string | null;
}

export function stateScopeOf(auth: Auth): StateScope {
	switch (auth.type) {
		case "virtual":
			return { virtualKeyId: auth.key.id, ownerActor: null };
		case "session":
			return { virtualKeyId: null, ownerActor: actorOf(auth) };
		default:
			return { virtualKeyId: null, ownerActor: null };
	}
}
