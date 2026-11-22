import { modelsWildcardHandler, listModelsHandler } from "#endpoints/models.ts";
import { createDeployment, deleteDeployment } from "#db/repos/deployments.ts";
import { jsonResponse, withStubbedFetch } from "#test-support/fetch.ts";
import { invalidatePublicModelGroups } from "#catalog/publicModels.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { chatCompletionsHandler } from "#endpoints/chat.ts";
import { eventually } from "#test-support/wait.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

import {
	makeOpenAIContractTestApp,
	makeGatewayTestApp,
} from "#test-support/app.ts";

import {
	listOperationsPage,
	getOperationDetail,
} from "#db/repos/operations.ts";

import "#adapters/index.ts";

const skip =
	(await pgAvailable()) && (await redisAvailable())
		? false
		: "Postgres/Redis unavailable";
const app = makeOpenAIContractTestApp((instance) => {
	instance.post("/v1/chat/completions", chatCompletionsHandler);
});

// /v1/models is public, outside the authenticated /v1/* of the contract app.
const modelsApp = makeGatewayTestApp((instance) => {
	instance.get("/v1/models", listModelsHandler);
	instance.get("/v1/models/*", modelsWildcardHandler);
});

function chat(model: string, requestId: string) {
	return app.request("/v1/chat/completions", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.MASTER_KEY}`,
			"content-type": "application/json",
			"x-request-id": requestId,
		},
		body: JSON.stringify({
			model,
			messages: [{ role: "user", content: "hello" }],
		}),
	});
}

async function operation(requestId: string) {
	return eventually(
		async () => {
			const { rows } = await listOperationsPage({
				limit: 1,
				offset: 0,
				requestId,
			});
			const [row] = rows;
			const detail = row ? await getOperationDetail(row.id) : null;
			return detail?.lifecycleState === "finished" ? detail : null;
		},
		{ description: `operation ${requestId}` },
	);
}

test("model:flex reaches OpenAI as service_tier=flex and bills the Flex rate", {
	skip,
}, async () => {
	const row = await createDeployment({
		publicModel: `service-mode-${randomUUID()}`,
		adapterKey: "openai",
		upstreamModel: "gpt-6.1-sol",
		credentials: { apiKey: "test-key" },
	});
	try {
		const sent: Record<string, unknown>[] = [];
		const requestId = randomUUID();
		await withStubbedFetch(
			(_input, init) => {
				sent.push(JSON.parse(String(init?.body)));
				return jsonResponse({
					id: "resp_1",
					created_at: 1,
					model: "gpt-6.1-sol",
					status: "completed",
					service_tier: "flex",
					output: [
						{
							type: "message",
							id: "msg_1",
							role: "assistant",
							content: [{ type: "output_text", text: "Hi.", annotations: [] }],
						},
					],
					usage: {
						input_tokens: 100_000,
						output_tokens: 0,
						total_tokens: 100_000,
					},
				});
			},
			async () => {
				const response = await chat(`${row.publicModel}:flex`, requestId);
				assert.equal(response.status, 200, await response.clone().text());
			},
		);
		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.service_tier, "flex");
		assert.equal(sent[0]?.model, "gpt-6.1-sol");
		const detail = await operation(requestId);
		// 100K short-context tokens of gpt-6.1-sol: $0.20 standard, $0.10 at Flex.
		assert.equal(Number(detail.consumerCostCents), 10);
	} finally {
		await deleteDeployment(row.id);
	}
});

test("a mode the deployment cannot serve is refused before any upstream call", {
	skip,
}, async () => {
	const row = await createDeployment({
		publicModel: `service-mode-${randomUUID()}`,
		adapterKey: "azureopenai",
		upstreamModel: "gpt-6.1-sol",
		credentials: {
			apiKey: "test-key",
			baseUrl: "https://resource.openai.azure.com/openai/v1",
		},
	});
	try {
		let calls = 0;
		await withStubbedFetch(
			() => {
				calls++;
				return jsonResponse({});
			},
			async () => {
				const response = await chat(`${row.publicModel}:fast`, randomUUID());
				assert.equal(response.status, 400);
				const body = (await response.json()) as { error: { code: string } };
				assert.equal(body.error.code, "unsupported_service_mode");
				// Without the suffix the same model still routes.
				const missing = await chat(`${row.publicModel}:nope`, randomUUID());
				assert.equal(missing.status, 404);
			},
		);
		assert.equal(calls, 0);
	} finally {
		await deleteDeployment(row.id);
	}
});

test("/v1/models lists only the modes the router would serve", {
	skip,
}, async () => {
	const openai = await createDeployment({
		publicModel: `service-mode-${randomUUID()}`,
		adapterKey: "openai",
		upstreamModel: "gpt-6.1-sol",
		credentials: { apiKey: "test-key" },
	});
	const azure = await createDeployment({
		publicModel: `service-mode-${randomUUID()}`,
		adapterKey: "azureopenai",
		upstreamModel: "gpt-6.1-sol",
		credentials: {
			apiKey: "test-key",
			baseUrl: "https://resource.openai.azure.com/openai/v1",
		},
	});
	try {
		invalidatePublicModelGroups();
		const modes = async (model: string) => {
			const response = await modelsApp.request(`/v1/models/${model}`);
			assert.equal(response.status, 200);
			return ((await response.json()) as { service_modes: string[] })
				.service_modes;
		};
		assert.deepEqual(await modes(openai.publicModel), [
			"fast",
			"flex",
			"priority",
		]);
		// Same model and prices, but the Azure adapter cannot request a tier.
		assert.deepEqual(await modes(azure.publicModel), []);
	} finally {
		await deleteDeployment(openai.id);
		await deleteDeployment(azure.id);
		invalidatePublicModelGroups();
	}
});
