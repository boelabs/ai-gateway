import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { responseCacheEpoch } from "#cache/responseCache.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { adminApp } from "#admin/index.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

import "#adapters/index.ts";

import { createDeployment, deleteDeployment } from "#deployments/service.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

const app = makeGatewayTestApp((a) => {
	a.route("/admin", adminApp);
});
const auth = {
	authorization: `Bearer ${env.MASTER_KEY}`,
	"content-type": "application/json",
};

test("only routing-relevant changes invalidate the response cache", {
	skip,
}, async () => {
	const before = await responseCacheEpoch();
	const created = await app.request("/admin/keys", {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ name: `epoch-${randomUUID()}` }),
	});
	assert.equal(created.status, 201);
	const { data } = (await created.json()) as { data: { id: string } };
	await app.request(`/admin/keys/${data.id}`, {
		method: "DELETE",
		headers: auth,
	});
	assert.equal(await responseCacheEpoch(), before);

	const deployment = await createDeployment({
		publicModel: `epoch-${randomUUID()}`,
		adapterKey: "openai",
		upstreamModel: "gpt-5.5",
		credentials: { apiKey: "test" },
	});
	try {
		assert.notEqual(await responseCacheEpoch(), before);
	} finally {
		await deleteDeployment(deployment.row.id);
	}
});
