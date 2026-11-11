import assert from "node:assert/strict";
import { test } from "node:test";

import {
	MAX_QUEUED_BYTES_PER_PROCESS,
	admitQueuedBytes,
	messageBytes,
} from "./realtimeSockets.ts";

test("a socket's queue is bounded by bytes, not only by count", () => {
	const connection = { queuedBytes: 0 };
	const first = admitQueuedBytes(connection, 20 * 1024 * 1024);
	assert.ok(first);
	// A second large message would hold more than the connection may queue.
	assert.equal(admitQueuedBytes(connection, 20 * 1024 * 1024), null);
	first.release();
	first.release();
	assert.equal(connection.queuedBytes, 0);
	assert.ok(admitQueuedBytes(connection, 20 * 1024 * 1024));
});

test("the process-wide bound holds across connections", () => {
	const held: { release: () => void }[] = [];
	let refused = false;
	for (let i = 0; i < 64 && !refused; i += 1) {
		const admitted = admitQueuedBytes(
			{ queuedBytes: 0 },
			MAX_QUEUED_BYTES_PER_PROCESS / 16,
		);
		if (admitted) {
			held.push(admitted);
		} else {
			refused = true;
		}
	}
	assert.equal(refused, true);
	for (const entry of held) {
		entry.release();
	}
});

test("message sizes count bytes of text and binary frames", () => {
	assert.equal(messageBytes("é"), 2);
	assert.equal(messageBytes(new ArrayBuffer(5)), 5);
	assert.equal(messageBytes(new Uint8Array(7)), 7);
});
