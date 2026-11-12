import { relay } from "#/shared/api/relay.ts";

/**
 * Changing one's own password. Like sign-in it cannot be a Server Action: the gateway revokes the
 * old sessions and answers with new session cookies, which the browser's own request must receive.
 */
export function POST(request: Request): Promise<Response> {
	return relay(request, "/auth/password");
}
