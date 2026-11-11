import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "#auth/types.ts";
import { randomUUID } from "node:crypto";

/**
 * A client's own request id is kept only when it is a plain token: it is echoed in headers, written
 * to logs and exported to CSV, where markup, spaces or a leading "=" would be someone else's input.
 */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function incomingRequestId(c: Context): string | null {
	const raw = c.req.header("x-request-id")?.trim();
	if (!(raw && REQUEST_ID.test(raw))) {
		return null;
	}
	return raw;
}

export function requestContextMiddleware(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const requestId = incomingRequestId(c) ?? randomUUID();
		c.set("requestId", requestId);
		// WebSocket upgrade headers are owned by the adapter and become immutable during upgrade.
		if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
			c.header("x-request-id", requestId);
		}
		await next();
	};
}

export function getRequestId(c: Context<AppEnv>): string {
	return c.get("turnRequestId") ?? c.get("requestId");
}

export function setHeaders(c: Context, headers: Record<string, string>): void {
	for (const [name, value] of Object.entries(headers)) {
		c.header(name, value);
	}
}
