/**
 * Headers that tell the gateway who is really calling when the dashboard's server makes a request on
 * a visitor's behalf.
 *
 * Without them every dashboard request reaches the gateway from one address with one user agent, so
 * its per-address sign-in throttle would treat every operator as a single client: one person failing
 * to sign in a few times would lock everyone out.
 *
 * `x-forwarded-for` is passed on as received. Next fills it from the socket only when no proxy set
 * it, so either way its last entry is the client as this dashboard saw it, and the gateway reaches
 * it by counting this dashboard as one of its `TRUSTED_PROXY_HOPS`.
 */
const CLIENT_HEADERS = ["x-forwarded-for", "user-agent"] as const;

export function gatewayClientHeaders(incoming: Headers): Headers {
	const headers = new Headers();
	for (const name of CLIENT_HEADERS) {
		const value = incoming.get(name);
		if (value) {
			headers.set(name, value);
		}
	}
	return headers;
}
