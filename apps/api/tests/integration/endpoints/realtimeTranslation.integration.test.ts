import { realtimeTranslationsHandler } from "#endpoints/realtimeTranslation.ts";
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
import { test } from "node:test";

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

/** An OpenAI translation stand-in: translates each audio chunk, drains on session.close. */
async function translationStub() {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const updates: Record<string, any>[] = [];
	const paths: string[] = [];
	let audioBytes = 0;
	server.on("connection", (socket, request) => {
		paths.push(request.url ?? "");
		socket.send(JSON.stringify({ type: "session.created", session: {} }));
		socket.on("message", (data) => {
			const event = JSON.parse(data.toString()) as Record<string, any>;
			if (event.type === "session.update") {
				updates.push(event.session);
				socket.send(
					JSON.stringify({ type: "session.updated", session: event.session }),
				);
			}
			if (event.type === "session.input_audio_buffer.append") {
				audioBytes += Buffer.from(event.audio, "base64").byteLength;
			}
			if (event.type === "session.close") {
				for (const reply of [
					{
						type: "session.input_transcript.delta",
						delta: "Hello.",
						elapsed_ms: 200,
					},
					{
						type: "session.output_audio.delta",
						delta: Buffer.alloc(480).toString("base64"),
						elapsed_ms: 200,
					},
					{
						type: "session.output_transcript.delta",
						delta: "Hola.",
						elapsed_ms: 200,
					},
					{ type: "session.closed" },
				]) {
					socket.send(JSON.stringify(reply));
				}
			}
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		updates,
		paths,
		audioBytes: () => audioBytes,
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
		testApp.get("/v1/realtime/translations", realtimeTranslationsHandler);
	});
	const server = startServer({
		fetch: (request, bindings) => app.fetch(request, bindings),
		port: 0,
		hostname: "127.0.0.1",
		maxRequestBodySize: 1024 * 1024,
	});
	return {
		url: `ws://127.0.0.1:${server.port}/v1/realtime/translations`,
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

test("GET /v1/realtime/translations relays OpenAI's protocol and bills translation plus its transcript", {
	skip,
	timeout: 30_000,
}, async () => {
	const stub = await translationStub();
	const server = await gateway();
	const publicModel = `translate-e2e-${randomUUID()}`;
	let deploymentId: string | undefined;
	let virtualKey: CreatedVirtualKey | undefined;
	try {
		const created = await createDeployment({
			publicModel,
			adapterKey: "openai",
			upstreamModel: "gpt-realtime-translate",
			credentials: { apiKey: "sk-test", baseUrl: stub.baseUrl },
		});
		deploymentId = created.row.id;
		virtualKey = await createVirtualKey({
			name: `translate-e2e-${randomUUID()}`,
		});

		// A transcript model the gateway cannot price is refused before any provider session.
		const refused = await client(
			`${server.url}?model=${publicModel}`,
			virtualKey.rawKey,
		);
		await refused.next("session.created");
		refused.socket.send(
			JSON.stringify({
				type: "session.update",
				session: {
					audio: { input: { transcription: { model: "no-such-model" } } },
				},
			}),
		);
		await refused.next("session.updated");
		refused.socket.send(
			JSON.stringify({
				type: "session.input_audio_buffer.append",
				event_id: "evt_audio",
				audio: Buffer.alloc(9600).toString("base64"),
			}),
		);
		const error = await refused.next("error");
		assert.equal(error.error.event_id, "evt_audio");
		assert.equal(error.error.param, "session.audio.input.transcription.model");
		assert.equal(stub.paths.length, 0);
		refused.socket.close();

		const { socket, events, next, closed } = await client(
			`${server.url}?model=${publicModel}`,
			virtualKey.rawKey,
		);
		const sessionCreated = await next("session.created");
		assert.equal(sessionCreated.session.type, "translation");
		assert.equal(sessionCreated.session.model, publicModel);
		socket.send(
			JSON.stringify({
				type: "session.update",
				session: {
					audio: {
						input: { transcription: { model: "gpt-realtime-whisper" } },
						output: { language: "es" },
					},
				},
			}),
		);
		const updated = await next("session.updated");
		assert.equal(updated.session.audio.output.language, "es");

		// One second of 24 kHz audio, then close: the provider drains and the gateway relays it.
		socket.send(
			JSON.stringify({
				type: "session.input_audio_buffer.append",
				audio: Buffer.alloc(48_000).toString("base64"),
			}),
		);
		socket.send(JSON.stringify({ type: "session.close" }));
		await next("session.closed");
		assert.equal(await closed, 1000);

		assert.deepEqual(stub.paths, [
			"/v1/realtime/translations?model=gpt-realtime-translate",
		]);
		assert.deepEqual(stub.updates[0]?.audio, {
			input: {
				transcription: { model: "gpt-realtime-whisper" },
				noise_reduction: null,
			},
			output: { language: "es" },
		});
		assert.equal(stub.audioBytes(), 48_000);
		const types = events.map((event) => event.type);
		for (const type of [
			"session.input_transcript.delta",
			"session.output_audio.delta",
			"session.output_transcript.delta",
		]) {
			assert.ok(types.includes(type), type);
		}
		const audio = events.find(
			(event) => event.type === "session.output_audio.delta",
		);
		assert.equal(audio?.sample_rate, 24_000);
		assert.ok(
			types.indexOf("session.output_transcript.delta") <
				types.indexOf("session.closed"),
		);

		const operation = await eventually(
			async () => {
				const page = await listOperationsPage({
					limit: 1,
					offset: 0,
					publicModel,
					callType: "realtime.translation",
				});
				const [row] = page.rows;
				const detail = row ? await getOperationDetail(row.id) : null;
				return detail?.outcome ? detail : null;
			},
			{ description: "translation gateway_operation", timeoutMs: 8000 },
		);
		assert.equal(operation.outcome, "success");
		// 1 s at $0.034/min (0.0567¢) plus its transcript on gpt-realtime-whisper at $0.017/min (0.0283¢).
		assert.ok(
			Math.abs(Number(operation.consumerCostCents) - 0.085) < 0.001,
			String(operation.consumerCostCents),
		);
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
