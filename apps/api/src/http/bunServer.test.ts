import { remoteAddress, startServer, upgradeWebSocket } from "./bunServer.ts";
import type { ServerBindings } from "./bunServer.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

function serve(app: Hono<{ Bindings: ServerBindings }>) {
	return startServer({
		fetch: (request, bindings) => app.fetch(request, bindings),
		port: 0,
		hostname: "127.0.0.1",
		maxRequestBodySize: 1024 * 1024,
	});
}

function opened(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("socket error")), {
			once: true,
		});
	});
}

test("the handshake answers the credential-free subprotocol, never the credential", async () => {
	const app = new Hono<{ Bindings: ServerBindings }>();
	app.get(
		"/ws",
		upgradeWebSocket(() => ({})),
	);
	const server = serve(app);
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, [
			"openai-insecure-api-key.sk-secret",
			"realtime",
		]);
		await opened(socket);
		assert.equal(socket.protocol, "realtime");
		socket.close();
	} finally {
		await server.stop(true);
	}
});

test("an upgraded request keeps its address and its signal outlives the socket", async () => {
	let address: string | null = null;
	let signal: AbortSignal | undefined;
	let closed!: () => void;
	const closedOnServer = new Promise<void>((resolve) => {
		closed = resolve;
	});
	const app = new Hono<{ Bindings: ServerBindings }>();
	app.get(
		"/ws",
		upgradeWebSocket((c) => ({
			onOpen() {
				address = remoteAddress(c);
				({ signal } = c.req.raw);
			},
			onMessage(event, ws) {
				// Binary arrives as exactly the bytes sent, and the context reports live state.
				assert.equal(ws.readyState, 1);
				assert.equal(
					typeof (ws.raw as unknown as { bufferedAmount: number })
						.bufferedAmount,
					"number",
				);
				ws.send(event.data as ArrayBuffer);
			},
			onClose() {
				closed();
			},
		})),
	);
	const server = serve(app);
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		socket.binaryType = "arraybuffer";
		await opened(socket);
		const echoed = new Promise<ArrayBuffer>((resolve) => {
			socket.addEventListener("message", (event) => resolve(event.data), {
				once: true,
			});
		});
		socket.send(new Uint8Array([1, 2, 3]));
		assert.deepEqual([...new Uint8Array(await echoed)], [1, 2, 3]);
		socket.close();
		await closedOnServer;
		assert.equal(address, "127.0.0.1");
		assert.equal(signal?.aborted, false);
	} finally {
		await server.stop(true);
	}
});
