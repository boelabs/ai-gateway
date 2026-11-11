import { requestContextMiddleware } from "./requestContext.ts";
import type { AppEnv } from "#auth/types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

const app = new Hono<AppEnv>();
app.use(requestContextMiddleware());
app.get("/", (c) => c.text(c.get("requestId")));

async function idFor(header: string): Promise<string> {
	const response = await app.request("/", {
		headers: { "x-request-id": header },
	});
	return response.text();
}

test("a client request id is kept only when it is a plain token", async () => {
	assert.equal(await idFor("req_01H-abc.9:z"), "req_01H-abc.9:z");
	for (const unsafe of [
		'=HYPERLINK("http://x")',
		"<script>",
		"a b",
		"x".repeat(200),
	]) {
		const id = await idFor(unsafe);
		assert.notEqual(id, unsafe);
		assert.match(id, /^[0-9a-f-]{36}$/u);
	}
});
