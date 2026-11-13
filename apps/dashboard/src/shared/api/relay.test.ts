import { relay, relayPath } from "./relay.ts";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
process.env.GATEWAY_URL = "https://gateway.test";

test("a relayed path cannot step out of its prefix", () => {
	assert.equal(
		relayPath("/v1", ["chat", "completions"]),
		"/v1/chat/completions",
	);
	for (const segments of [
		["..", "admin", "keys"],
		["."],
		["a/b"],
		["a\\b"],
		[""],
		[],
	]) {
		assert.equal(relayPath("/v1", segments), null, JSON.stringify(segments));
	}
});

test("only the gateway routes the dashboard uses are relayed", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		return new Response("{}");
	}) as unknown as typeof fetch;
	const request = (method: string) =>
		new Request("https://dash.test/api/v1/x", { method });
	assert.equal((await relay(request("GET"), "/admin/keys")).status, 404);
	assert.equal(
		(await relay(request("DELETE"), "/v1/videos/video_1")).status,
		404,
	);
	assert.equal((await relay(request("POST"), null)).status, 404);
	assert.equal(calls, 0);
	assert.equal((await relay(request("GET"), "/v1/videos/video_1")).status, 200);
	assert.equal(calls, 1);
});

test("the browser leaving cancels the gateway call", async () => {
	let forwarded: AbortSignal | null | undefined;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		forwarded = init?.signal;
		return new Response("{}");
	}) as unknown as typeof fetch;
	const browser = new AbortController();
	await relay(
		new Request("https://dash.test/api/v1/chat/completions", {
			method: "POST",
			body: "{}",
			signal: browser.signal,
		}),
		"/v1/chat/completions",
	);
	assert.ok(forwarded);
	browser.abort();
	assert.equal(forwarded?.aborted, true);
});
