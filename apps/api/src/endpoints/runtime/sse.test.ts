import assert from "node:assert/strict";
import { test } from "node:test";

import {
	markDownstreamSemanticWritten,
	markDownstreamTerminalWritten,
	newDownstreamWriteObservation,
	awaitWithSSEHeartbeats,
	withSSEHeartbeats,
	writeSSEHeartbeat,
	writeSSE,
} from "./sse.ts";

test("awaitWithSSEHeartbeats keeps pre-output work alive", async () => {
	let heartbeats = 0;
	const value = await awaitWithSSEHeartbeats(
		new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 25)),
		async () => {
			heartbeats += 1;
		},
		5,
	);
	assert.equal(value, "ready");
	assert.ok(heartbeats >= 2);
});

test("awaitWithSSEHeartbeats preserves rejection", async () => {
	const failure = new Error("routing failed");
	await assert.rejects(
		() =>
			awaitWithSSEHeartbeats(
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(failure), 15),
				),
				async () => {
					/* intentionally empty */
				},
				5,
			),
		(error: unknown) => error === failure,
	);
});

test("downstream observation distinguishes transport, semantic, and terminal writes", async () => {
	const observation = newDownstreamWriteObservation();
	const writer = {
		async write() {
			/* intentionally empty */
		},
		async writeSSE() {
			/* intentionally empty */
		},
	};
	await writeSSEHeartbeat(writer, observation);
	assert.equal(observation.deliveryState, "opened");
	assert.equal(observation.writes, 1);
	assert.ok(observation.firstWriteAt !== null);
	assert.equal(observation.firstSemanticWriteAt, null);

	await writeSSE(writer, { data: "semantic" }, observation);
	markDownstreamSemanticWritten(observation);
	assert.equal(observation.deliveryState, "semantic_written");
	assert.ok(observation.firstSemanticWriteAt !== null);

	await writeSSE(writer, { data: "[DONE]" }, observation);
	markDownstreamTerminalWritten(observation);
	assert.equal(observation.deliveryState, "terminal_written");
	assert.ok(observation.terminalWriteAt !== null);
	assert.equal(observation.writes, 3);
});

test("downstream observation does not count rejected writes as delivered bytes", async () => {
	const observation = newDownstreamWriteObservation();
	const failure = new Error("closed");
	await assert.rejects(
		() =>
			writeSSE(
				{
					async write() {
						/* intentionally empty */
					},
					async writeSSE() {
						throw failure;
					},
				},
				{ data: "not delivered" },
				observation,
			),
		(error: unknown) => error === failure,
	);
	assert.equal(observation.deliveryState, "write_failed");
	assert.equal(observation.bytes, 0);
	assert.equal(observation.writes, 0);
	assert.ok(observation.writeFailedAt !== null);
});

test("withSSEHeartbeats surfaces a read-ahead failure that happens while the consumer is busy", async () => {
	const failure = new Error("upstream reset");
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		async function* upstream() {
			yield "first";
			throw failure;
		}
		const seen: string[] = [];
		await assert.rejects(
			async () => {
				for await (const item of withSSEHeartbeats(
					upstream(),
					async () => {
						/* intentionally empty */
					},
					1000,
				)) {
					seen.push(item);
					// A slow client: the read-ahead rejects while this body is still running.
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
			},
			(error: unknown) => error === failure,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(seen, ["first"]);
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("withSSEHeartbeats sends heartbeats while the next item is pending", async () => {
	let heartbeats = 0;
	async function* upstream() {
		await new Promise((resolve) => setTimeout(resolve, 30));
		yield "late";
	}
	const seen: string[] = [];
	for await (const item of withSSEHeartbeats(
		upstream(),
		async () => {
			heartbeats += 1;
		},
		5,
	)) {
		seen.push(item);
	}
	assert.deepEqual(seen, ["late"]);
	assert.ok(heartbeats >= 2);
});
