import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { adminApp } from "#admin/index.ts";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

import "#adapters/index.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("malformed admin paging and ids are the caller's error, not a 500", {
	skip,
}, async () => {
	const app = makeGatewayTestApp((a) => {
		a.route("/admin", adminApp);
	});
	const headers = { authorization: `Bearer ${env.MASTER_KEY}` };
	const status = async (path: string, method = "GET") =>
		(await app.request(path, { method, headers })).status;
	assert.equal(await status("/admin/deployments?limit=abc"), 400);
	assert.equal(await status("/admin/keys?offset=-1"), 400);
	assert.equal(await status("/admin/deployments?limit=5000"), 200);
	assert.equal(await status("/admin/deployments/not-a-uuid"), 404);
	assert.equal(await status("/admin/deployments/not-a-uuid", "DELETE"), 404);
	assert.equal(await status("/admin/logs/not-a-uuid"), 404);
	assert.equal(await status("/admin/users/not-a-uuid"), 404);
	assert.equal(await status("/admin/keys/not-a-uuid", "DELETE"), 204);
});
