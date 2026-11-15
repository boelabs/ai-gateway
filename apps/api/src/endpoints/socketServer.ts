import { env } from "#config/env.ts";

/**
 * What every public WebSocket shares: which subprotocol the server answers with, a heartbeat that
 * ends connections whose peer went away without closing, and an idle timeout. The sockets themselves
 * are Bun's (see http/bunServer.ts); this module only needs the few calls below.
 */

/** Subprotocols that carry a credential; never echoed back in the handshake response. */
const CREDENTIAL_PROTOCOL = /api-key|key\.|token|secret/iu;

/**
 * The subprotocol the server agrees to: the first one the client offered that carries no credential
 * (`realtime`), else none. Echoing the first one offered would, for an OpenAI Realtime browser
 * client, be `openai-insecure-api-key.<key>`: the key would come back in a header.
 */
export function chooseProtocol(protocols: Iterable<string>): string | false {
	for (const protocol of protocols) {
		if (!CREDENTIAL_PROTOCOL.test(protocol)) {
			return protocol;
		}
	}
	return false;
}

/** Parses a `Sec-WebSocket-Protocol` request header into the offered subprotocols, in order. */
export function offeredProtocols(header: string | null | undefined): string[] {
	return (header ?? "")
		.split(",")
		.map((protocol) => protocol.trim())
		.filter((protocol) => protocol.length > 0);
}

/** The calls the heartbeat makes on a socket. */
export interface HeartbeatSocket {
	ping: () => unknown;
	terminate: () => void;
	close: (code?: number, reason?: string) => void;
}

interface SocketActivity {
	alive: boolean;
	lastMessageAt: number;
}

const activity = new Map<HeartbeatSocket, SocketActivity>();

/** Starts tracking an open socket. */
export function trackSocket(socket: HeartbeatSocket, now = Date.now()): void {
	activity.set(socket, { alive: true, lastMessageAt: now });
}

/** Stops tracking a closed socket. */
export function untrackSocket(socket: HeartbeatSocket): void {
	activity.delete(socket);
}

/** The peer answered the last ping. */
export function notePong(socket: HeartbeatSocket): void {
	const state = activity.get(socket);
	if (state) {
		state.alive = true;
	}
}

/** The peer sent a message: it is not idle. */
export function noteMessage(socket: HeartbeatSocket, now = Date.now()): void {
	const state = activity.get(socket);
	if (state) {
		state.lastMessageAt = now;
	}
}

/** The sockets currently open. */
export function trackedSockets(): IterableIterator<HeartbeatSocket> {
	return activity.keys();
}

/**
 * One heartbeat round: a socket that did not answer the previous ping is terminated (its peer is
 * gone: a closed laptop, a dropped network), one silent for longer than the idle timeout is closed,
 * and the rest are pinged.
 */
export function heartbeat(now = Date.now()): void {
	for (const [socket, state] of activity) {
		if (!state.alive) {
			untrackSocket(socket);
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

/** Runs the heartbeat on its interval; returns the function that stops it. */
export function startHeartbeat(): () => void {
	const timer = setInterval(
		() => heartbeat(),
		env.WEBSOCKET_HEARTBEAT_INTERVAL_MS,
	);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Bytes a socket may have waiting to be written before its client counts as too slow. */
export const MAX_BUFFERED_SEND_BYTES = 8 * 1024 * 1024;

/** Largest message a client may send. */
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 16 * 1024 * 1024;
