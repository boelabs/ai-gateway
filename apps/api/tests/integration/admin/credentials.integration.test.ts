import { pgAvailable, redisAvailable } from "#test-support/infra.ts";
import { makeGatewayTestApp } from "#test-support/app.ts";
import { providerCredentials } from "#db/schema.ts";
import { adminApp } from "#admin/index.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

import "#adapters/index.ts";

import {
	deleteProviderCredential,
	openProviderCredential,
} from "#db/repos/providerCredentials.ts";

import {
	getDeploymentCredentials,
	deleteDeployment,
} from "#db/repos/deployments.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

const app = makeGatewayTestApp((routes) => {
	routes.route("/", adminApp);
});

function call(method: string, path: string, body?: unknown) {
	return app.request(path, {
		method,
		headers: {
			authorization: `Bearer ${env.MASTER_KEY}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

interface CredentialView {
	id: string;
	name: string;
	adapterKey: string;
	fields: string[];
	hint: { apiKey?: string; baseUrl?: string };
}

async function data<T>(response: Response): Promise<T> {
	return ((await response.json()) as { data: T }).data;
}

test("saved credentials fill deployments without becoming a dependency", {
	skip,
}, async () => {
	const name = `Anthropic ${randomUUID()}`;
	const apiKey = `sk-ant-${randomUUID()}`;
	const credentialIds: string[] = [];
	const deploymentIds: string[] = [];
	try {
		const created = await call("POST", "/credentials", {
			name,
			adapterKey: "anthropic",
			credentials: { apiKey },
		});
		assert.equal(created.status, 201);
		const credential = await data<CredentialView>(created);
		credentialIds.push(credential.id);
		assert.deepEqual(credential.fields, ["apiKey"]);
		assert.equal(credential.hint.apiKey, apiKey.slice(-4));
		assert.ok(!JSON.stringify(credential).includes(apiKey));

		// The same name in another case, and the same secret under another name, are both refused.
		const sameName = await call("POST", "/credentials", {
			name: name.toUpperCase(),
			adapterKey: "anthropic",
			credentials: { apiKey: `${apiKey}-other` },
		});
		assert.equal(sameName.status, 400);
		assert.match(await sameName.text(), /credential_name_taken/u);
		const sameSecret = await call("POST", "/credentials", {
			name: `${name} copy`,
			adapterKey: "anthropic",
			credentials: { apiKey },
		});
		assert.equal(sameSecret.status, 400);
		assert.match(await sameSecret.text(), /credential_duplicate/u);

		// Credentials are saved or typed, never a mix of both.
		const both = await call("POST", "/deployments", {
			publicModel: `cred-${randomUUID()}`,
			adapterKey: "anthropic",
			upstreamModel: "claude-sonnet-4-5",
			credentialId: credential.id,
			credentials: { apiKey: "typed" },
		});
		assert.equal(both.status, 400);

		// A credential of another adapter cannot fill this one.
		const wrongAdapter = await call("POST", "/deployments", {
			publicModel: `cred-${randomUUID()}`,
			adapterKey: "openai",
			upstreamModel: "gpt-5.4",
			credentialId: credential.id,
		});
		assert.equal(wrongAdapter.status, 400);

		const deployment = await call("POST", "/deployments", {
			publicModel: `cred-${randomUUID()}`,
			adapterKey: "anthropic",
			upstreamModel: "claude-sonnet-4-5",
			credentialId: credential.id,
		});
		assert.equal(deployment.status, 201, await deployment.clone().text());
		const { id: deploymentId } = await data<{ id: string }>(deployment);
		deploymentIds.push(deploymentId);
		assert.deepEqual(await getDeploymentCredentials(deploymentId), { apiKey });

		// Replacing the saved key does not reach the deployment filled earlier.
		const rotated = await call("PATCH", `/credentials/${credential.id}`, {
			credentials: { apiKey: `${apiKey}-rotated` },
		});
		assert.equal(rotated.status, 200);
		assert.deepEqual(await getDeploymentCredentials(deploymentId), { apiKey });

		// Deleting it does not either.
		assert.equal(
			(await call("DELETE", `/credentials/${credential.id}`)).status,
			204,
		);
		credentialIds.length = 0;
		assert.deepEqual(await getDeploymentCredentials(deploymentId), { apiKey });

		// And a deployment's credentials can be saved again without retyping them.
		const saved = await call("POST", "/credentials", {
			name: `${name} restored`,
			fromDeploymentId: deploymentId,
		});
		assert.equal(saved.status, 201);
		const restored = await data<CredentialView>(saved);
		credentialIds.push(restored.id);
		assert.equal(restored.adapterKey, "anthropic");

		// An envelope copied onto another row does not open there.
		const [row] = await db
			.select()
			.from(providerCredentials)
			.where(eq(providerCredentials.id, restored.id));
		assert.ok(row);
		assert.deepEqual(openProviderCredential(row), { apiKey });
		assert.throws(() =>
			openProviderCredential({ id: randomUUID(), secret: row.secret }),
		);
	} finally {
		for (const id of deploymentIds) {
			await deleteDeployment(id);
		}
		for (const id of credentialIds) {
			await deleteProviderCredential(id);
		}
	}
});
