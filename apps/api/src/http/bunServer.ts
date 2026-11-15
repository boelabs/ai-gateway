import type { UpgradeWebSocket, WSEvents } from "hono/ws";
import { defineWebSocketHelper, WSContext } from "hono/ws";
import type { Context } from "hono";

import {
	MAX_WEBSOCKET_PAYLOAD_BYTES,
	offeredProtocols,
	chooseProtocol,
	untrackSocket,
	noteMessage,
	trackSocket,
	notePong,
} from "#endpoints/socketServer.ts";

/**
 * The HTTP and WebSocket server, on Bun's native `Bun.serve`.
 *
 * Hono's own `hono/bun` WebSocket helper is not used: it cannot set the handshake's
 * `Sec-WebSocket-Protocol` (so a browser client offering `realtime` plus a credential subprotocol
 * would be refused), it snapshots `readyState` when the context is created, and it is deprecated.
 */

interface SocketData {
	events: WSEvents<Bun.ServerWebSocket<SocketData>>;
	url: URL;
	protocol: string;
	context?: WSContext<Bun.ServerWebSocket<SocketData>>;
}

type Socket = Bun.ServerWebSocket<SocketData>;

/** Bindings handed to every request, so handlers reach the server that accepted it. */
export interface ServerBindings {
	server: Bun.Server;
}

function serverOf(c: Context): Bun.Server | undefined {
	return (c.env as Partial<ServerBindings> | undefined)?.server;
}

/** Addresses of upgraded requests, whose `c.req.raw` is a detached copy Bun cannot look up. */
const upgradedAddresses = new WeakMap<Request, string | null>();

/** The remote address of the connection that carried this request, as Bun saw it. */
export function remoteAddress(c: Context): string | null {
	const known = upgradedAddresses.get(c.req.raw);
	if (known !== undefined) {
		return known;
	}
	return serverOf(c)?.requestIP(c.req.raw)?.address ?? null;
}

/**
 * The handshake request, detached from its connection. Bun aborts an upgraded request's `signal`
 * the moment the socket closes, and the operation log reads that abort as the client cancelling:
 * every socket that closed normally would log its last turn as cancelled. The socket's lifetime is
 * already handled by `onClose` and each turn's own AbortController, so the handlers get a copy of
 * the request whose signal never fires, keeping its URL, method and headers.
 */
function detachUpgradeRequest(c: Context, address: string | null): void {
	const original = c.req.raw;
	const detached = new Request(original.url, {
		method: original.method,
		headers: original.headers,
	});
	upgradedAddresses.set(detached, address);
	c.req.raw = detached;
}

/**
 * One context per socket, created when it opens and reused for every event, so a handler that keeps
 * the socket from `onOpen` holds the same object later. `readyState` is read live, and `raw` exposes
 * the bytes still waiting to be written, which the handlers watch for slow clients.
 */
function contextOf(ws: Socket): WSContext<Socket> {
	let { context } = ws.data;
	if (!context) {
		const raw = Object.assign(Object.create(null) as object, {
			socket: ws,
			get bufferedAmount() {
				return ws.getBufferedAmount();
			},
		});
		context = new WSContext<Socket>({
			send: (source) => {
				ws.send(source as string | ArrayBufferLike | Uint8Array);
			},
			raw: raw as unknown as Socket,
			get readyState() {
				return ws.readyState as 0 | 1 | 2 | 3;
			},
			url: ws.data.url,
			protocol: ws.data.protocol,
			close: (code, reason) => {
				ws.close(code, reason);
			},
		});
		ws.data.context = context;
	}
	return context;
}

/** Text arrives as a string; binary as an ArrayBuffer of exactly the message's bytes. */
function messageData(message: string | Uint8Array): string | ArrayBuffer {
	if (typeof message === "string") {
		return message;
	}
	return message.buffer.slice(
		message.byteOffset,
		message.byteOffset + message.byteLength,
	) as ArrayBuffer;
}

export const upgradeWebSocket: UpgradeWebSocket<Socket> =
	defineWebSocketHelper<Socket>((c, events) => {
		const server = serverOf(c);
		if (!server) {
			throw new TypeError("The request was not served by Bun.serve.");
		}
		const protocol = chooseProtocol(
			offeredProtocols(c.req.header("sec-websocket-protocol")),
		);
		const original = c.req.raw;
		// Bun may run `open` inside `upgrade()`, so the handlers must already see the detached
		// request; and it can no longer look the connection up once the request is upgraded.
		detachUpgradeRequest(c, server.requestIP(original)?.address ?? null);
		const upgraded = server.upgrade<SocketData>(original, {
			...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
			data: { events, url: new URL(c.req.url), protocol: protocol || "" },
		});
		if (!upgraded) {
			c.req.raw = original;
			return;
		}
		// Bun answers the handshake itself; Hono only needs a placeholder response.
		return new Response(null);
	});

/** Bun's WebSocket handlers: dispatch to the Hono events and keep the heartbeat informed. */
const websocket: Bun.WebSocketHandler<SocketData> = {
	maxPayloadLength: MAX_WEBSOCKET_PAYLOAD_BYTES,
	perMessageDeflate: false,
	// The heartbeat (endpoints/socketServer.ts) owns liveness and idleness, as it did before.
	idleTimeout: 0,
	sendPings: false,
	open(ws) {
		trackSocket(ws);
		ws.data.events.onOpen?.(new Event("open"), contextOf(ws));
	},
	message(ws, message) {
		noteMessage(ws);
		ws.data.events.onMessage?.(
			new MessageEvent("message", { data: messageData(message) }),
			contextOf(ws),
		);
	},
	pong(ws) {
		notePong(ws);
	},
	close(ws, code, reason) {
		untrackSocket(ws);
		ws.data.events.onClose?.(
			new CloseEvent("close", { code, reason }),
			contextOf(ws),
		);
	},
};

export interface StartServerOptions {
	fetch: (
		request: Request,
		bindings: ServerBindings,
	) => Response | Promise<Response>;
	port: number;
	hostname?: string;
	/** Largest request body Bun will accept; the routes enforce their own, smaller limits. */
	maxRequestBodySize: number;
}

export function startServer(options: StartServerOptions): Bun.Server {
	return Bun.serve<SocketData>({
		port: options.port,
		...(options.hostname ? { hostname: options.hostname } : {}),
		// Bun closes a connection after 10 s without traffic by default, which would cut a stream
		// still waiting on a reasoning model's first token. Request time limits are the router's
		// execution policy, not the socket's.
		idleTimeout: 0,
		maxRequestBodySize: options.maxRequestBodySize,
		fetch: (request, server) => options.fetch(request, { server }),
		websocket,
	});
}
