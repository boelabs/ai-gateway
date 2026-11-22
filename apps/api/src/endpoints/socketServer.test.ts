import assert from "node:assert/strict";
import { test } from "node:test";

import {
	offeredProtocols,
	chooseProtocol,
	untrackSocket,
	trackSocket,
	heartbeat,
	notePong,
} from "./socketServer.ts";

test("the handshake never echoes a credential subprotocol", () => {
	assert.equal(
		chooseProtocol(new Set(["openai-insecure-api-key.sk-secret", "realtime"])),
		"realtime",
	);
	assert.equal(
		chooseProtocol(new Set(["openai-insecure-api-key.sk-secret"])),
		false,
	);
	assert.deepEqual(
		offeredProtocols(" realtime , openai-insecure-api-key.sk-secret,"),
		["realtime", "openai-insecure-api-key.sk-secret"],
	);
	assert.deepEqual(offeredProtocols(undefined), []);
});

class FakeSocket {
	pings = 0;
	terminated = false;
	closedWith: number | null = null;
	ping() {
		this.pings += 1;
	}
	terminate() {
		this.terminated = true;
	}
	close(code?: number) {
		this.closedWith = code ?? null;
	}
}

test("a socket that misses a pong is dropped and an idle one is closed", () => {
	const live = new FakeSocket();
	const silent = new FakeSocket();
	trackSocket(live);
	trackSocket(silent);
	heartbeat();
	assert.equal(live.pings, 1);
	notePong(live);
	heartbeat();
	assert.equal(live.terminated, false);
	assert.equal(silent.terminated, true);
	untrackSocket(live);

	const idle = new FakeSocket();
	trackSocket(idle);
	heartbeat(Date.now() + 24 * 60 * 60 * 1000);
	assert.equal(idle.closedWith, 1000);
	untrackSocket(idle);
});
