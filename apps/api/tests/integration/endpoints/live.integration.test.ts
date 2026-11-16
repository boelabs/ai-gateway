import { jsonResponse, withStubbedFetch } from "#test-support/fetch.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeOpenAIContractTestApp } from "#test-support/app.ts";
import { deleteDeployment } from "#db/repos/deployments.ts";
import { createDeployment } from "#deployments/service.ts";
import { eventually } from "#test-support/wait.ts";
import { startServer } from "#http/bunServer.ts";
import { WebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

import {
	liveSessionsSocketHandler,
	liveAttachSocketHandler,
	liveCreateHandler,
} from "#endpoints/live.ts";

import {
	type CreatedVirtualKey,
	createVirtualKey,
	deleteVirtualKey,
} from "#db/repos/virtualKeys.ts";

import {
	listOperationsPage,
	getOperationDetail,
} from "#db/repos/operations.ts";

import "#adapters/index.ts";

const hasInfra = (await pgAvailable()) && (await redisAvailable());
const skip = hasInfra ? false : "Postgres/Redis unavailable";

/**
 * A GPT-Live stand-in. A primary session answers session.start, then on session.close reports its
 * usage (a backend response, then the final seconds) and closes. A sideband attach reports only the
 * final seconds.
 */
async function liveStub() {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const starts: Record<string, any>[] = [];
	const paths: string[] = [];
	const authorizations: string[] = [];
	server.on("connection", (socket, request) => {
		const path = request.url ?? "";
		paths.push(path);
		authorizations.push(request.headers.authorization ?? "");
		if (path.endsWith("/attach")) {
			socket.send(
				JSON.stringify({
					type: "session.closed",
					event_id: "event_s1",
					reason: "remote_hangup",
					session: { id: "live_rtc", model: "gpt-live-1" },
					usage: { seconds: 12 },
				}),
			);
			socket.close(1000);
			return;
		}
		socket.on("message", (data) => {
			const event = JSON.parse(data.toString()) as Record<string, any>;
			if (event.type === "session.start") {
				starts.push(event.session);
				socket.send(
					JSON.stringify({
						type: "session.started",
						event_id: "event_1",
						session: {
							id: "live_ws",
							model: event.session.model,
							status: "active",
						},
					}),
				);
				return;
			}
			if (event.type === "session.close") {
				for (const reply of [
					{
						type: "response.event",
						event_id: "event_2",
						event: {
							type: "response.completed",
							response: {
								id: "resp_1",
								model: "gpt-6-luna",
								usage: { input_tokens: 100_000, output_tokens: 0 },
							},
						},
					},
					{
						type: "session.closed",
						event_id: "event_3",
						reason: "close_requested",
						session: { id: "live_ws", model: "gpt-live-1" },
						usage: { seconds: 60 },
					},
				]) {
					socket.send(JSON.stringify(reply));
				}
				socket.close(1000);
			}
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		starts,
		paths,
		authorizations,
		close: () =>
			new Promise<void>((resolve) => {
				for (const connection of server.clients) {
					connection.terminate();
				}
				server.close(() => resolve());
			}),
	};
}

async function gateway() {
	const app = makeOpenAIContractTestApp((testApp) => {
		testApp.get("/v1/live/sessions", liveSessionsSocketHandler);
		testApp.post("/v1/live/sessions", liveCreateHandler);
		testApp.get("/v1/live/sessions/:id/attach", liveAttachSocketHandler);
	});
	const server = startServer({
		fetch: (request, bindings) => app.fetch(request, bindings),
		port: 0,
		hostname: "127.0.0.1",
		maxRequestBodySize: 1024 * 1024,
	});
	return {
		url: `ws://127.0.0.1:${server.port}/v1/live/sessions`,
		app,
		close: () => server.stop(true),
	};
}

async function client(url: string, key: string) {
	const socket = new WebSocket(url, {
		headers: { authorization: `Bearer ${key}` },
	});
	const events: Record<string, any>[] = [];
	const closed = new Promise<number>((resolve) =>
		socket.on("close", (code) => resolve(code)),
	);
	socket.on("message", (data) => events.push(JSON.parse(data.toString())));
	await new Promise<void>((resolve, reject) => {
		socket.once("open", () => resolve());
		socket.once("error", reject);
	});
	const next = (type: string) =>
		eventually(() => events.find((event) => event.type === type), {
			description: type,
		});
	return { socket, events, next, closed };
}

async function finishedOperation(publicModel: string) {
	return eventually(
		async () => {
			const page = await listOperationsPage({
				limit: 1,
				offset: 0,
				publicModel,
				callType: "live.session",
			});
			const [row] = page.rows;
			const detail = row ? await getOperationDetail(row.id) : null;
			return detail?.outcome ? detail : null;
		},
		{ description: "live gateway_operation", timeoutMs: 8000 },
	);
}

test("GET /v1/live/sessions relays a session under its public name and bills seconds plus the backend", {
	skip,
	timeout: 30_000,
}, async () => {
	const stub = await liveStub();
	const server = await gateway();
	const publicModel = `live-e2e-${randomUUID()}`;
	let deploymentId: string | undefined;
	let virtualKey: CreatedVirtualKey | undefined;
	try {
		const created = await createDeployment({
			publicModel,
			adapterKey: "openai",
			upstreamModel: "gpt-live-1",
			credentials: { apiKey: "sk-test", baseUrl: stub.baseUrl },
		});
		deploymentId = created.row.id;
		virtualKey = await createVirtualKey({ name: `live-e2e-${randomUUID()}` });

		// Delegating to a model the gateway cannot price is refused before any provider session.
		const refused = await client(server.url, virtualKey.rawKey);
		refused.socket.send(
			JSON.stringify({
				type: "session.start",
				event_id: "evt_start",
				session: {
					model: publicModel,
					delegation: {
						type: "responses",
						responses: { model: "no-such-model" },
					},
				},
			}),
		);
		const error = await refused.next("error");
		assert.equal(error.client_event_id, "evt_start");
		assert.equal(error.error.param, "session.delegation");
		assert.equal(stub.starts.length, 0);
		refused.socket.close();

		const { socket, next, closed } = await client(
			server.url,
			virtualKey.rawKey,
		);
		socket.send(
			JSON.stringify({
				type: "session.start",
				session: {
					model: publicModel,
					instructions: "Be brief.",
					delegation: { type: "responses", responses: { model: "gpt-6-luna" } },
				},
			}),
		);
		const started = await next("session.started");
		assert.equal(started.session.model, publicModel);
		assert.equal(started.session.id, "live_ws");
		assert.equal(stub.starts[0]?.model, "gpt-live-1");
		assert.equal(stub.starts[0]?.instructions, "Be brief.");
		assert.deepEqual(stub.paths, ["/v1/live/sessions"]);
		assert.deepEqual(stub.authorizations, ["Bearer sk-test"]);

		socket.send(JSON.stringify({ type: "session.close" }));
		const sessionClosed = await next("session.closed");
		assert.equal(sessionClosed.session.model, publicModel);
		assert.equal(await closed, 1000);

		const operation = await finishedOperation(publicModel);
		assert.equal(operation.outcome, "success");
		// 60 s at $0.05/min (5 cents) plus 100K gpt-6-luna input tokens at $0.10/1M (1 cent).
		assert.ok(
			Math.abs(Number(operation.consumerCostCents) - 6) < 0.01,
			String(operation.consumerCostCents),
		);

		// Only the key that opened a session may attach to it.
		const other = await createVirtualKey({
			name: `live-other-${randomUUID()}`,
		});
		try {
			const response = await server.app.request(
				"/v1/live/sessions/live_ws/attach",
				{
					headers: {
						authorization: `Bearer ${other.rawKey}`,
						upgrade: "websocket",
					},
				},
			);
			assert.equal(response.status, 404);
		} finally {
			await deleteVirtualKey(other.row.id);
		}
	} finally {
		if (virtualKey) {
			await deleteVirtualKey(virtualKey.row.id);
		}
		if (deploymentId) {
			await deleteDeployment(deploymentId);
		}
		await server.close();
		await stub.close();
	}
});

test("POST /v1/live/sessions creates a WebRTC session and meters it from the sideband", {
	skip,
	timeout: 30_000,
}, async () => {
	const stub = await liveStub();
	const server = await gateway();
	const publicModel = `live-rtc-${randomUUID()}`;
	let deploymentId: string | undefined;
	try {
		const created = await createDeployment({
			publicModel,
			adapterKey: "openai",
			upstreamModel: "gpt-live-1",
			credentials: { apiKey: "sk-test", baseUrl: stub.baseUrl },
		});
		deploymentId = created.row.id;
		const sent: Array<{ url: string; body: Record<string, any> }> = [];
		await withStubbedFetch(
			(input, init) => {
				sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
				return jsonResponse(
					{
						session: { id: "live_rtc" },
						transport: { type: "webrtc", sdp: "v=0 answer" },
					},
					201,
				);
			},
			async () => {
				const response = await server.app.request("/v1/live/sessions", {
					method: "POST",
					headers: {
						authorization: `Bearer ${env.MASTER_KEY}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						session: { model: publicModel },
						transport: { type: "webrtc", sdp: "v=0 offer" },
					}),
				});
				assert.equal(response.status, 201, await response.clone().text());
				const body = (await response.json()) as Record<string, any>;
				assert.equal(body.transport.sdp, "v=0 answer");
			},
		);
		assert.match(sent[0]?.url ?? "", /\/v1\/live\/sessions$/u);
		assert.equal(sent[0]?.body.session.model, "gpt-live-1");
		const operation = await finishedOperation(publicModel);
		assert.ok(stub.paths.includes("/v1/live/sessions/live_rtc/attach"));
		// 12 s at $0.05/min.
		assert.ok(
			Math.abs(Number(operation.consumerCostCents) - 1) < 0.01,
			String(operation.consumerCostCents),
		);
	} finally {
		if (deploymentId) {
			await deleteDeployment(deploymentId);
		}
		await server.close();
		await stub.close();
	}
});
