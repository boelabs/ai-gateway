import { afterEach, expect, mock, test } from "bun:test";

const calls: string[] = [];
mock.module("next/server", () => ({
	connection: async () => {
		calls.push("connection");
	},
}));

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
process.env.GATEWAY_URL = "https://gateway.test";

test("readiness waits for a request and is never cached", async () => {
	let init: RequestInit | undefined;
	globalThis.fetch = (async (_input: unknown, options?: RequestInit) => {
		calls.push("fetch");
		init = options;
		return Response.json({
			status: "ok",
			dependencies: { database: true, cache: true },
			time: "2026-01-01T00:00:00Z",
		});
	}) as unknown as typeof fetch;
	const { readiness } = await import("./health.ts");
	const result = await readiness();
	expect(result?.status).toBe("ok");
	expect(calls).toEqual(["connection", "fetch"]);
	expect(init?.cache).toBe("no-store");
});
