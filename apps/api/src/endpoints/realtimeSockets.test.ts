import type { ContentfulStatusCode } from "hono/utils/http-status";
import { responsesWebSocketHandler } from "./responses.ts";
import { realtimeWebSocketHandler } from "./realtime.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";
import { Hono } from "hono";

function app(): Hono<AppEnv> {
	const instance = new Hono<AppEnv>();
	instance.onError((error, c) =>
		GatewayError.is(error)
			? c.text(
					error.code ?? error.class,
					error.httpStatus as ContentfulStatusCode,
				)
			: c.text("server", 500),
	);
	instance.use("*", async (c, next) => {
		c.set("auth", { type: "master" });
		return next();
	});
	instance.get("/v1/responses", responsesWebSocketHandler);
	instance.get("/v1/realtime", realtimeWebSocketHandler);
	return instance;
}

test("plain GETs are refused before they can hold a WebSocket slot", async () => {
	const instance = app();
	const attempts =
		Math.max(
			env.RESPONSES_WEBSOCKET_MAX_CONNECTIONS_PER_KEY,
			env.REALTIME_WEBSOCKET_MAX_CONNECTIONS_PER_KEY,
		) + 2;
	for (let i = 0; i < attempts; i += 1) {
		const responses = await instance.request(
			"http://gateway.test/v1/responses",
		);
		assert.equal(responses.status, 426);
		const realtime = await instance.request(
			"http://gateway.test/v1/realtime?model=m",
		);
		assert.equal(realtime.status, 426);
	}
});
