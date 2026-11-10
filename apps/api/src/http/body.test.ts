import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import {
	ADMIN_JSON_BODY_MAX_BYTES,
	readBodyBytes,
	readJsonBody,
} from "./body.ts";

function chunked(chunks: number, size: number): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= chunks) {
				controller.close();
				return;
			}
			sent += 1;
			controller.enqueue(new Uint8Array(size).fill(0x20));
		},
	});
}

test("a chunked body over the cap is refused while it is read", async () => {
	const app = new Hono<AppEnv>();
	let status = 0;
	app.post("/", async (c) => {
		try {
			await readBodyBytes(c, 1024);
		} catch (error) {
			status = GatewayError.is(error) ? error.httpStatus : 500;
		}
		return c.text("done");
	});
	await app.request("http://gateway.test/", {
		method: "POST",
		body: chunked(64, 256),
		duplex: "half",
	} as RequestInit);
	assert.equal(status, 413);
});

test("middleware and handler share one read of the body", async () => {
	const app = new Hono<AppEnv>();
	let parsed: unknown;
	app.use("*", async (c, next) => {
		await readBodyBytes(c, ADMIN_JSON_BODY_MAX_BYTES);
		return next();
	});
	app.post("/", async (c) => {
		parsed = await readJsonBody(c, ADMIN_JSON_BODY_MAX_BYTES);
		return c.text("done");
	});
	await app.request("http://gateway.test/", {
		method: "POST",
		body: JSON.stringify({ name: "k" }),
	});
	assert.deepEqual(parsed, { name: "k" });
});
