import { WebSocketServer, type WebSocket } from "ws";
import { env } from "#config/env.ts";

/**
 * The public WebSocket server and what every socket on it shares: which subprotocol it answers
 * with, a heartbeat that ends connections whose peer went away without closing, and an idle timeout.
 */

/** Subprotocols that carry a credential; never echoed back in the handshake response. */
const CREDENTIAL_PROTOCOL = /api-key|key\.|token|secret/iu;

/**
 * The subprotocol the server agrees to: the first one the client offered that carries no credential
 * (`realtime`), else none. The `ws` default echoes the first one offered, which for an OpenAI
 * Realtime browser client is `openai-insecure-api-key.<key>`: the key would come back in a header.
 */
export function chooseProtocol(protocols: Set<string>): string | false {
	for (const protocol of protocols) {
		if (!CREDENTIAL_PROTOCOL.test(protocol)) {
			return protocol;
		}
	}
	return false;
}

interface SocketActivity {
	alive: boolean;
	lastMessageAt: number;
}

const activity = new WeakMap<WebSocket, SocketActivity>();

function track(socket: WebSocket): SocketActivity {
	let state = activity.get(socket);
	if (!state) {
		const tracked: SocketActivity = { alive: true, lastMessageAt: Date.now() };
		socket.on("pong", () => {
			tracked.alive = true;
		});
		socket.on("message", () => {
			tracked.lastMessageAt = Date.now();
		});
		activity.set(socket, tracked);
		state = tracked;
	}
	return state;
}

/**
 * One heartbeat round: a socket that did not answer the previous ping is terminated (its peer is
 * gone: a closed laptop, a dropped network), one silent for longer than the idle timeout is closed,
 * and the rest are pinged.
 */
export function heartbeat(server: WebSocketServer, now = Date.now()): void {
	for (const socket of server.clients) {
		const state = track(socket);
		if (!state.alive) {
			socket.terminate();
			continue;
		}
		if (now - state.lastMessageAt > env.WEBSOCKET_IDLE_TIMEOUT_MS) {
			socket.close(1000, "idle timeout");
			continue;
		}
		state.alive = false;
		socket.ping();
	}
}

export function createSocketServer(): {
	server: WebSocketServer;
	stop: () => void;
} {
	const server = new WebSocketServer({
		noServer: true,
		maxPayload: 16 * 1024 * 1024,
		perMessageDeflate: false,
		handleProtocols: chooseProtocol,
	});
	server.on("connection", (socket) => {
		track(socket);
	});
	const timer = setInterval(
		() => heartbeat(server),
		env.WEBSOCKET_HEARTBEAT_INTERVAL_MS,
	);
	timer.unref?.();
	return { server, stop: () => clearInterval(timer) };
}

/** Bytes a socket may have waiting to be written before its client counts as too slow. */
export const MAX_BUFFERED_SEND_BYTES = 8 * 1024 * 1024;
