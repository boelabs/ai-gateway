import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { authMiddleware } from "#auth/middleware.ts";
import { issueSession } from "#auth/session.ts";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

const skip =
	(await Promise.all([pgAvailable(), redisAvailable()])).every(Boolean) &&
	env.DASH_ENABLED
		? false
		: "Postgres/Redis or the dashboard unavailable";

test("a session cookie never authenticates a WebSocket upgrade", {
	skip,
}, async () => {
	const app = makeGatewayTestApp((a) => {
		a.get("/v1/realtime", authMiddleware(), (c) => c.text("opened"));
	});
	const issued = await issueSession({
		userId: null,
		userEpoch: null,
		role: "owner",
		ip: null,
		userAgent: null,
	});
	const cookie = `ai_gateway_session=${issued.token}`;
	const upgrade = await app.request("/v1/realtime", {
		headers: { cookie, upgrade: "websocket", connection: "upgrade" },
	});
	assert.equal(upgrade.status, 401);
	const body = (await upgrade.json()) as { error: { code: string | null } };
	assert.equal(body.error.code, "session_websocket_refused");
	assert.equal(
		(await app.request("/v1/realtime", { headers: { cookie } })).status,
		200,
	);
});
