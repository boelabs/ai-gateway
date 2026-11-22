import { EventQueue, closeStatus, rawText } from "./google/live.ts";
import type { OpenAIRealtimeDeps } from "./openaiRealtime.ts";
import { abortGatewayError } from "#gateway/abortReason.ts";
import { GatewayError } from "#core/errors.ts";

import type {
	LiveSessionHandler,
	LiveServerFrame,
	AdapterContext,
	LiveUpstream,
} from "./types.ts";

import {
	upstreamWebSocket,
	upstreamFetch,
} from "#gateway/instrumentedTransport.ts";

/**
 * OpenAI's GPT-Live API (`/v1/live/sessions`) as a live upstream, on OpenAI or on Azure's v1 surface.
 * Frames are relayed as received; the handler only opens the sockets, waits for the session to start
 * and maps failures, so the client sees OpenAI's protocol unchanged.
 */

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** `https://api.openai.com/v1` + `/abc/attach` -> `https://api.openai.com/v1/live/sessions/abc/attach`. */
export function openAILiveUrl(
	base: string,
	path = "",
	protocol: "http" | "ws" = "http",
): string {
	const url = new URL(base);
	if (protocol === "ws") {
		url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
	}
	url.pathname = `${url.pathname.replace(/\/+$/u, "")}/live/sessions${path}`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

/** The HTTP status an OpenAI `error` event stands for, so failover and the client see the right class. */
export function liveErrorStatus(
	error: Record<string, unknown> | undefined,
): number {
	const type = String(error?.type ?? "");
	const code = String(error?.code ?? "");
	if (/rate_limit|concurren|quota/iu.test(`${type} ${code}`)) {
		return 429;
	}
	if (type === "authentication_error") {
		return 401;
	}
	if (type === "permission_error") {
		return 403;
	}
	if (type === "invalid_request_error") {
		return code === "model_not_found" ? 404 : 400;
	}
	return 502;
}

function frame(text: string): LiveServerFrame | null {
	try {
		const event = record(JSON.parse(text));
		return event ? { text, event } : null;
	} catch {
		return null;
	}
}

/**
 * Opens a live socket. With `start`, sends it and resolves once the provider answers
 * `session.started` (or rejects on its `error`); without, resolves when the socket opens.
 */
function openLiveSocket(
	deps: OpenAIRealtimeDeps,
	ctx: AdapterContext,
	path: string,
	start: Record<string, unknown> | null,
): Promise<LiveUpstream> {
	const connection = deps.resolveConnection(ctx);
	const socket = upstreamWebSocket(
		ctx,
		openAILiveUrl(connection.url, path, "ws"),
		{
			headers: connection.headers,
		},
	);
	const queue = new EventQueue<LiveServerFrame>();
	let closed = false;
	let started: Record<string, unknown> | null = null;

	return new Promise<LiveUpstream>((resolve, reject) => {
		let ready = false;
		const upstream = (): LiveUpstream => ({
			started,
			send(text) {
				if (!closed && socket.readyState === socket.OPEN) {
					socket.send(text);
				}
			},
			frames: queue.iterate(),
			close() {
				if (closed) {
					return;
				}
				closed = true;
				queue.end();
				socket.close(1000);
			},
		});
		const becomeReady = () => {
			ready = true;
			ctx.watchdog?.headers();
			ctx.watchdog?.complete();
			resolve(upstream());
		};
		const failOrReject = (error: unknown) => {
			if (ready) {
				if (!closed) {
					closed = true;
					queue.fail(error);
				}
			} else {
				reject(error);
			}
		};

		socket.on("open", () => {
			if (start) {
				socket.send(JSON.stringify(start));
			} else {
				becomeReady();
			}
		});
		socket.on("message", (data) => {
			const text = rawText(data);
			const parsed = frame(text);
			if (!parsed) {
				failOrReject(
					new GatewayError({
						class: "server",
						code: "upstream_protocol_error",
						message: `${deps.label} live emitted a message that is not a JSON object`,
					}),
				);
				return;
			}
			if (!ready) {
				if (parsed.event.type === "session.started") {
					started = parsed.event;
					becomeReady();
					return;
				}
				if (parsed.event.type === "error") {
					const error = record(parsed.event.error);
					reject(
						deps.mapError(
							{ status: liveErrorStatus(error), body: { error } },
							ctx,
						),
					);
					socket.close(1000);
					return;
				}
			}
			queue.push(parsed);
		});
		socket.on("error", (error) => {
			if (!ready) {
				reject(deps.mapError(error, ctx));
			}
		});
		socket.on("unexpected-response", (_request, response) => {
			reject(
				deps.mapError(
					{
						status: response.statusCode ?? 502,
						body: { error: { message: response.statusMessage } },
					},
					ctx,
				),
			);
		});
		socket.on("close", (code, reasonBuffer) => {
			if (closed) {
				return;
			}
			if (ctx.signal?.aborted) {
				failOrReject(abortGatewayError(ctx.signal));
				return;
			}
			if (ready && code === 1000) {
				// The provider ended the session (after `session.closed`).
				closed = true;
				queue.end();
				return;
			}
			const reason = reasonBuffer.toString();
			failOrReject(
				deps.mapError(
					{
						status: closeStatus(code, reason),
						body: {
							error: {
								code,
								message:
									reason || `${deps.label} live closed with code ${code}`,
							},
						},
					},
					ctx,
				),
			);
		});
	});
}

export function makeOpenAILiveHandler(
	deps: OpenAIRealtimeDeps,
): LiveSessionHandler {
	const request = async (
		ctx: AdapterContext,
		path: string,
		init: RequestInit,
	): Promise<Response> => {
		const connection = deps.resolveConnection(ctx);
		const response = await upstreamFetch(
			ctx,
			openAILiveUrl(connection.url, path),
			{
				...init,
				headers: {
					...connection.headers,
					...(init.headers as Record<string, string>),
				},
			},
		);
		if (!response.ok) {
			const text = await response.text();
			let body: unknown = text;
			try {
				body = JSON.parse(text);
			} catch {
				// A non-JSON error body is passed on as text.
			}
			throw deps.mapError({ status: response.status, body }, ctx);
		}
		return response;
	};

	return {
		start: (start, ctx, forkOf) =>
			openLiveSocket(
				deps,
				ctx,
				forkOf ? `/${encodeURIComponent(forkOf)}/fork` : "",
				start,
			),
		attach: (sessionId, ctx) =>
			openLiveSocket(
				deps,
				ctx,
				`/${encodeURIComponent(sessionId)}/attach`,
				null,
			),
		async create(body, ctx, forkOf) {
			const response = await request(
				ctx,
				forkOf ? `/${encodeURIComponent(forkOf)}/fork` : "",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			);
			ctx.watchdog?.complete();
			const parsed = record(await response.json());
			if (!parsed) {
				throw new GatewayError({
					class: "server",
					code: "upstream_protocol_error",
					message: `${deps.label} live returned a body that is not a JSON object`,
				});
			}
			return { status: response.status, body: parsed };
		},
		content: (sessionId, ctx) =>
			request(ctx, `/${encodeURIComponent(sessionId)}/content`, {
				method: "GET",
			}),
	};
}
