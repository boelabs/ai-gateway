import { MAX_BUFFERED_SEND_BYTES } from "./socketServer.ts";
import { RealtimeClientEventError } from "#contracts/openai/realtime.ts";
import type { DownstreamWriteObservation } from "./runtime/sse.ts";
import { getAuth, revalidateAuth } from "#auth/middleware.ts";
import { toGatewayError } from "./runtime/pipeline.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import type { WSContext } from "hono/ws";
import { env } from "#config/env.ts";
import type { Context } from "hono";

/**
 * What every `/v1/realtime` socket shares, whatever kind of session it carries: the connection
 * limits, the message rules, and shutdown.
 */

export const REALTIME_MAX_MS = 60 * 60 * 1000;
/**
 * A realtime client event: an audio chunk is a few kilobytes, an image item a few megabytes. The
 * cap keeps one frame from holding a process's memory.
 */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MAX_QUEUED_EVENTS = 2000;
/** Bytes of client messages one socket may have waiting to be handled. */
export const MAX_QUEUED_BYTES_PER_CONNECTION = 32 * 1024 * 1024;
/** Bytes of waiting client messages across every socket of the process. */
export const MAX_QUEUED_BYTES_PER_PROCESS = 512 * 1024 * 1024;

let processQueuedBytes = 0;

/** Size of a raw WebSocket message as received. */
export function messageBytes(data: unknown): number {
	if (typeof data === "string") {
		return Buffer.byteLength(data, "utf8");
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	if (ArrayBuffer.isView(data)) {
		return data.byteLength;
	}
	if (data instanceof Blob) {
		return data.size;
	}
	return 0;
}

/**
 * Admits a client message to a socket's queue by its bytes, per connection and per process; false
 * means the caller closes the socket, since a client that sends faster than it is served would
 * otherwise grow memory without bound. `release` returns the bytes once the message is handled.
 */
export function admitQueuedBytes(
	queue: { queuedBytes: number },
	bytes: number,
	perConnection = MAX_QUEUED_BYTES_PER_CONNECTION,
): { release: () => void } | null {
	if (
		queue.queuedBytes + bytes > perConnection ||
		processQueuedBytes + bytes > MAX_QUEUED_BYTES_PER_PROCESS
	) {
		return null;
	}
	queue.queuedBytes += bytes;
	processQueuedBytes += bytes;
	let released = false;
	return {
		release: () => {
			if (released) {
				return;
			}
			released = true;
			queue.queuedBytes -= bytes;
			processQueuedBytes -= bytes;
		},
	};
}

export function queuedBytesError(): GatewayError {
	return new GatewayError({
		class: "rate_limit",
		code: "websocket_queue_bytes_exceeded",
		message: "Realtime WebSocket queued-bytes limit exceeded",
		publicMessage: "Client messages arrive faster than they can be handled.",
	});
}
/** How often an open socket's credential is re-checked between provider runs. */
export const CREDENTIAL_CHECK_MS = 60_000;

/**
 * Re-checks the connection's credential now (at every provider run start) and stores the fresh
 * identity on the context, so a revoked key or session cannot open new runs.
 */
export async function revalidateConnection(c: Context<AppEnv>): Promise<void> {
	c.set("auth", await revalidateAuth(c, getAuth(c)));
}

/**
 * Re-checks the credential on a timer for as long as the socket is open, so a disabled key or a
 * revoked session ends a session that would otherwise outlive it by up to an hour. Returns a stop.
 */
export function watchCredential(
	c: Context<AppEnv>,
	onRevoked: (error: GatewayError) => void,
): () => void {
	const timer = setInterval(() => {
		revalidateConnection(c).catch((error: unknown) => {
			clearInterval(timer);
			onRevoked(toGatewayError(error));
		});
	}, CREDENTIAL_CHECK_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

export interface RealtimeSocketEntry {
	scopeKey: string;
	socket: WSContext | null;
	/** A provider session is open: shutdown waits for its usage to be logged. */
	busy: () => boolean;
	/** Ends the provider session and logs it; idempotent. */
	close: () => Promise<void>;
}

const activeRealtimeSockets = new Set<RealtimeSocketEntry>();

export function capacityLimitError(): GatewayError {
	return new GatewayError({
		class: "rate_limit",
		code: "websocket_connection_limit_exceeded",
		message: "Realtime WebSocket connection concurrency limit exceeded",
		publicMessage: "Realtime WebSocket connection limit exceeded.",
	});
}

function atCapacity(scopeKey: string): boolean {
	const forScope = [...activeRealtimeSockets].filter(
		(active) => active.scopeKey === scopeKey,
	).length;
	return (
		activeRealtimeSockets.size >= env.REALTIME_WEBSOCKET_MAX_CONNECTIONS ||
		forScope >= env.REALTIME_WEBSOCKET_MAX_CONNECTIONS_PER_KEY
	);
}

/**
 * Refuses a request that is not a WebSocket handshake. Hono builds the socket's handlers before it
 * checks for the upgrade, so state built for a plain GET would never be released.
 */
export function assertWebSocketUpgrade(c: {
	req: { header: (name: string) => string | undefined };
}): void {
	if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
		throw new GatewayError({
			class: "bad_request",
			status: 426,
			code: "upgrade_required",
			message: "This endpoint only accepts WebSocket connections",
			publicMessage: "This endpoint only accepts WebSocket connections.",
		});
	}
}

/**
 * Checks the connection limits before the handshake, so a refused client gets an HTTP error. The
 * socket only takes a slot once it is open (`registerRealtimeSocket` in `onOpen`): a handshake that
 * fails never opens, never reaches `onClose`, and so must never have held one.
 */
export function assertRealtimeSocketCapacity(scopeKey: string): void {
	if (atCapacity(scopeKey)) {
		throw capacityLimitError();
	}
}

/**
 * Takes a slot for an open socket. Returns false when concurrent handshakes filled the limit after
 * the pre-check; the caller closes the socket.
 */
export function registerRealtimeSocket(entry: RealtimeSocketEntry): boolean {
	if (atCapacity(entry.scopeKey)) {
		return false;
	}
	activeRealtimeSockets.add(entry);
	return true;
}

export function unregisterRealtimeSocket(entry: RealtimeSocketEntry): void {
	activeRealtimeSockets.delete(entry);
}

export function sendRealtimeEvent(
	socket: WSContext | null,
	value: Record<string, unknown>,
	downstream?: DownstreamWriteObservation,
): void {
	if (socket?.readyState !== 1) {
		return;
	}
	// Realtime events cannot wait (audio keeps arriving), so a client that stops reading is not
	// waited for: past the ceiling of unsent bytes it is disconnected rather than buffered forever.
	const raw = socket.raw as { bufferedAmount?: number } | undefined;
	if ((raw?.bufferedAmount ?? 0) > MAX_BUFFERED_SEND_BYTES) {
		socket.close(1008, "client is not reading");
		return;
	}
	const serialized = JSON.stringify(value);
	socket.send(serialized);
	if (downstream) {
		downstream.bytes += Buffer.byteLength(serialized);
	}
}

/** A client message as text, refusing binary frames and oversized messages. */
export function realtimeMessageJson(value: unknown): unknown {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else if (value instanceof ArrayBuffer) {
		text = Buffer.from(value).toString("utf8");
	} else if (ArrayBuffer.isView(value)) {
		text = Buffer.from(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).toString("utf8");
	} else {
		throw new RealtimeClientEventError(
			"Realtime messages must be JSON text.",
			"invalid_event",
			null,
			null,
		);
	}
	if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
		throw new RealtimeClientEventError(
			"Realtime message is too large.",
			"invalid_event",
			null,
			null,
		);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new RealtimeClientEventError(
			"Invalid JSON.",
			"invalid_json",
			null,
			null,
		);
	}
}

export function sessionExpiredError(): GatewayError {
	return new GatewayError({
		class: "bad_request",
		code: "session_expired",
		message: "Realtime session reached 60 minutes",
		publicMessage: "Your session hit the maximum duration of 60 minutes.",
	});
}

export function eventQueueLimitError(): GatewayError {
	return new GatewayError({
		class: "rate_limit",
		code: "websocket_event_queue_limit_exceeded",
		message: "Realtime WebSocket queued-event limit exceeded",
		publicMessage: "Too many queued events.",
	});
}

/**
 * Hangs up live realtime sockets during process shutdown. Idle ones (no provider session) go first;
 * the rest get 1012 "service restarting" when the drain window closes, after their usage is logged.
 */
export async function closeRealtimeWebSockets(
	options: { idleOnly?: boolean } = {},
): Promise<void> {
	const closing: Promise<void>[] = [];
	for (const entry of activeRealtimeSockets) {
		if (options.idleOnly && entry.busy()) {
			continue;
		}
		const { socket } = entry;
		closing.push(
			entry.close().finally(() => socket?.close(1012, "service restarting")),
		);
	}
	await Promise.allSettled(closing);
}
