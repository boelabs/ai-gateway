import type { AdapterContext } from "#adapters/types.ts";
import { abortGatewayError } from "./abortReason.ts";
import WebSocket, { type ClientOptions } from "ws";

const MAX_REDIRECTS = 5;
/** Headers that carry nothing secret, the only ones a redirect to another origin keeps. */
const CROSS_ORIGIN_HEADERS = new Set([
	"accept",
	"accept-encoding",
	"accept-language",
	"content-type",
	"user-agent",
]);

/**
 * fetch with redirects followed by hand. The request carries the deployment's credentials (an
 * Authorization, api-key or x-api-key header, or a custom one), and fetch would repeat custom
 * headers to whatever origin a redirect names. A same-origin redirect keeps them; a redirect to
 * another origin (a signed download URL, say) is followed with none of them.
 */
async function fetchFollowingRedirects(
	input: string | URL | Request,
	init: RequestInit,
): Promise<Response> {
	if (input instanceof Request) {
		return fetch(input, init);
	}
	let url = new URL(String(input));
	let current: RequestInit = { ...init, redirect: "manual" };
	for (let hop = 0; ; hop += 1) {
		const response = await fetch(url, current);
		const location = response.headers.get("location");
		if (
			response.status < 300 ||
			response.status >= 400 ||
			location === null ||
			hop >= MAX_REDIRECTS
		) {
			return response;
		}
		await response.body?.cancel().catch(() => undefined);
		const next = new URL(location, url);
		const headers = new Headers(current.headers);
		if (next.origin !== url.origin) {
			for (const name of [...headers.keys()]) {
				if (!CROSS_ORIGIN_HEADERS.has(name.toLowerCase())) {
					headers.delete(name);
				}
			}
		}
		// 303, and 301/302 after a POST, continue as a GET without the body, as browsers do.
		const toGet =
			response.status === 303 ||
			((response.status === 301 || response.status === 302) &&
				(current.method ?? "GET").toUpperCase() === "POST");
		current = {
			...current,
			headers,
			...(toGet ? { method: "GET", body: null } : {}),
		};
		if (toGet) {
			headers.delete("content-type");
		}
		url = next;
	}
}

/** The only network entry point adapters may use for upstream HTTP calls. */
export async function upstreamFetch(
	ctx: AdapterContext,
	input: string | URL | Request,
	init: RequestInit = {},
): Promise<Response> {
	try {
		const response = await fetchFollowingRedirects(input, {
			...init,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		ctx.watchdog?.headers();
		if (!response.body) {
			return response;
		}
		ctx.transportStats ??= { upstreamBytes: 0 };
		const stats = ctx.transportStats;
		const { watchdog } = ctx;
		const counted = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					stats.upstreamBytes += chunk.byteLength;
					watchdog?.bytes();
					controller.enqueue(chunk);
				},
			}),
		);
		return new Response(counted, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		if (ctx.signal?.aborted) {
			throw abortGatewayError(ctx.signal, "response");
		}
		throw error;
	}
}

/** The only network entry point adapters may use for upstream WebSocket sessions. */
export function upstreamWebSocket(
	ctx: AdapterContext,
	url: string,
	options: ClientOptions,
): WebSocket {
	const socket = new WebSocket(url, options);
	ctx.transportStats ??= { upstreamBytes: 0 };
	const stats = ctx.transportStats;
	socket.on("message", (data) => {
		ctx.watchdog?.bytes();
		if (typeof data === "string") {
			stats.upstreamBytes += Buffer.byteLength(data);
		} else if (data instanceof ArrayBuffer) {
			stats.upstreamBytes += data.byteLength;
		} else if (Array.isArray(data)) {
			stats.upstreamBytes += data.reduce(
				(total, part) => total + part.byteLength,
				0,
			);
		} else {
			stats.upstreamBytes += data.byteLength;
		}
	});
	const abort = () => socket.terminate();
	if (ctx.signal?.aborted) {
		abort();
	} else {
		ctx.signal?.addEventListener("abort", abort, { once: true });
	}
	socket.once("close", () => ctx.signal?.removeEventListener("abort", abort));
	return socket;
}
