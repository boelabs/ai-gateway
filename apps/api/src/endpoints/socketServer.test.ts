import { EventEmitter } from "node:events";
import type { WebSocketServer } from "ws";
import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseProtocol, heartbeat } from "./socketServer.ts";

test("the handshake never echoes a credential subprotocol", () => {
	assert.equal(
		chooseProtocol(new Set(["openai-insecure-api-key.sk-secret", "realtime"])),
		"realtime",
	);
	assert.equal(
		chooseProtocol(new Set(["openai-insecure-api-key.sk-secret"])),
		false,
	);
});

class FakeSocket extends EventEmitter {
	pings = 0;
	terminated = false;
	closedWith: number | null = null;
	ping() {
		this.pings += 1;
	}
	terminate() {
		this.terminated = true;
	}
	close(code: number) {
		this.closedWith = code;
	}
}

test("a socket that misses a pong is dropped and an idle one is closed", () => {
	const live = new FakeSocket();
	const silent = new FakeSocket();
	const server = {
		clients: new Set([live, silent]),
	} as unknown as WebSocketServer;
	heartbeat(server);
	assert.equal(live.pings, 1);
	live.emit("pong");
	heartbeat(server);
	assert.equal(live.terminated, false);
	assert.equal(silent.terminated, true);
	const idle = new FakeSocket();
	const idleServer = { clients: new Set([idle]) } as unknown as WebSocketServer;
	heartbeat(idleServer, Date.now() + 24 * 60 * 60 * 1000);
	assert.equal(idle.closedWith, 1000);
});
