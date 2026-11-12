import { listDeploymentCandidates } from "#gateway/deploymentCandidates.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { invalidateVirtualKey } from "#auth/virtualKeyCache.ts";
import { deleteDeployment } from "#db/repos/deployments.ts";
import { createDeployment } from "#deployments/service.ts";
import { requestContextMiddleware } from "#http/requestContext.ts";
import { withStubbedFetch } from "#test-support/fetch.ts";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { authMiddleware } from "#auth/middleware.ts";
import { eventually } from "#test-support/wait.ts";
import { GatewayError } from "#core/errors.ts";
import type { AppEnv } from "#auth/types.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

import {
	type CreatedVirtualKey,
	createVirtualKey,
	deleteVirtualKey,
} from "#db/repos/virtualKeys.ts";

import {
	systemOneDecisionsHandler,
	geminiDecisionsHandler,
	openAIDecisionsHandler,
} from "#endpoints/decisions.ts";

import {
	listOperationsPage,
	getOperationDetail,
} from "#db/repos/operations.ts";

import "#adapters/index.ts";

const hasInfra = (await pgAvailable()) && (await redisAvailable());
const skip = hasInfra ? false : "Postgres/Redis unavailable";

/** The three decisions routes, each answering errors in its own contract's shape. */
function decisionsApp(): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("*", requestContextMiddleware());
	app.onError((err, c) => {
		if (!GatewayError.is(err)) {
			return c.json({ error: "internal" }, 500);
		}
		const status = err.httpStatus as ContentfulStatusCode;
		if (c.req.path === "/v1beta/decisions") {
			return c.json(err.toGoogle(), status);
		}
		return c.req.path === "/v1/systemone"
			? c.json(err.toTypeSafe(), status)
			: c.json(err.toOpenAI(), status);
	});
	app.use("/v1/*", authMiddleware());
	app.use("/v1beta/*", authMiddleware());
	app.post("/v1/decisions", openAIDecisionsHandler);
	app.post("/v1beta/decisions", geminiDecisionsHandler);
	app.post("/v1/systemone", systemOneDecisionsHandler);
	return app;
}

async function waitForOperation(requestId: string) {
	return eventually(
		async () => {
			const page = await listOperationsPage({ limit: 1, offset: 0, requestId });
			const [operation] = page.rows;
			const detail = operation ? await getOperationDetail(operation.id) : null;
			return detail && detail.attempts.length > 0 ? detail : null;
		},
		{ description: `gateway_operation ${requestId}` },
	);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("decisions contracts translate across providers, fall back, and log safely", {
	skip,
}, async () => {
	const app = decisionsApp();
	const publicModel = `decide-e2e-${randomUUID()}`;
	const deploymentIds: string[] = [];
	let virtualKey: CreatedVirtualKey | undefined;

	try {
		for (const deployment of [
			{
				adapterKey: "googleaistudio",
				upstreamModel: "gemini-decision-1",
				credentials: { apiKey: "google-test-key" },
			},
			{
				adapterKey: "typesafe",
				upstreamModel: "jev-1.14.0",
				credentials: { apiKey: "typesafe-test-key" },
			},
		] as const) {
			const created = await createDeployment({ publicModel, ...deployment });
			deploymentIds.push(created.row.id);
		}
		const candidates = await listDeploymentCandidates(publicModel, "decisions");
		assert.deepEqual(
			candidates.map((candidate) => candidate.adapter.key).sort(),
			["googleaistudio", "typesafe"],
		);
		virtualKey = await createVirtualKey({
			name: `decide-e2e-${randomUUID()}`,
			allowedModels: [publicModel],
		});
		const auth = { authorization: `Bearer ${virtualKey.rawKey}` };

		// A box question only Jev answers: the Gemini deployment is ineligible, so the OpenAI-shaped
		// request still cannot ask it, but the TypeSafe one can.
		const typeSafeRequestId = randomUUID();
		const upstreamUrls: string[] = [];
		await withStubbedFetch(
			async (input, init) => {
				upstreamUrls.push(String(input));
				const body = JSON.parse(String(init?.body)) as {
					questions: Record<string, unknown>;
				};
				assert.deepEqual(Object.keys(body.questions), ["refund", "where"]);
				return json({
					model: "jev-1.14.0",
					answers: {
						refund: { type: "noul", noul: 0.9 },
						where: {
							type: "box",
							box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 },
							confidence: 0.8,
						},
					},
					usage: { input_tokens: 1000, output_tokens: 2 },
				});
			},
			async () => {
				const response = await app.request("/v1/systemone", {
					method: "POST",
					headers: {
						...auth,
						"content-type": "application/json",
						"x-request-id": typeSafeRequestId,
					},
					body: JSON.stringify({
						model: publicModel,
						state: "private ticket text",
						questions: {
							refund: { type: "noul", instructions: "Wants a refund." },
							where: { type: "box", instructions: "The receipt" },
						},
					}),
				});
				assert.equal(response.status, 200, await response.clone().text());
				assert.deepEqual(await response.json(), {
					model: publicModel,
					answers: {
						refund: { type: "noul", noul: 0.9 },
						where: {
							type: "box",
							box: { top: 0.1, bottom: 0.2, left: 0.3, right: 0.4 },
							confidence: 0.8,
						},
					},
					usage: { input_tokens: 1000, output_tokens: 2 },
				});
			},
		);
		assert.deepEqual(upstreamUrls, ["https://api.typesafe.ai/v1/systemone"]);
		const operation = await waitForOperation(typeSafeRequestId);
		assert.equal(operation.callType, "decisions");
		assert.equal(operation.promptTokens, 1000);
		// Jev input at $0.042 per million tokens.
		assert.equal(Number(operation.consumerCostCents), 0.0042);
		assert.doesNotMatch(
			JSON.stringify({
				request: operation.requestSummary,
				response: operation.responseSummary,
			}),
			/private ticket|Wants a refund|receipt/u,
		);

		// The OpenAI contract over whichever provider answers; a failing first attempt falls back.
		let attempts = 0;
		await withStubbedFetch(
			async (input) => {
				attempts += 1;
				if (attempts === 1) {
					return json({ error: { message: "busy" } }, 503);
				}
				return String(input).includes("googleapis")
					? json({
							answers: {
								q0: { type: "noul", noul: 0.25, confidence: 0.75 },
								team: {
									type: "choice",
									choice: "billing",
									probabilities: { billing: 0.8, technical: 0.2 },
									confidence: 0.8,
								},
							},
							usage: { total_input_tokens: 40, total_output_tokens: 0 },
						})
					: json({
							model: "jev-1.14.0",
							answers: {
								q0: { type: "noul", noul: 0.25 },
								team: {
									type: "choice",
									choice: "billing",
									confidence: 0.8,
									probabilities: { billing: 0.8, technical: 0.2 },
								},
							},
							usage: { input_tokens: 40, output_tokens: 0 },
						});
			},
			async () => {
				const response = await app.request("/v1/decisions", {
					method: "POST",
					headers: { ...auth, "content-type": "application/json" },
					body: JSON.stringify({
						model: publicModel,
						input: "Charged twice for March.",
						questions: [
							{ type: "predicate", instructions: "Wants a refund." },
							{
								type: "choice",
								name: "team",
								instructions: "Owning team.",
								choices: [{ value: "billing" }, { value: "technical" }],
							},
						],
					}),
				});
				assert.equal(response.status, 200, await response.clone().text());
				const body = (await response.json()) as {
					answers: Record<string, unknown>[];
				};
				assert.deepEqual(body.answers[0], {
					type: "predicate",
					name: null,
					probability: 0.25,
				});
				assert.equal(body.answers[1]?.choice, "billing");
				assert.deepEqual(body.answers[1]?.probabilities, [
					{ value: "billing", probability: 0.8 },
					{ value: "technical", probability: 0.2 },
				]);
			},
		);
		assert.equal(attempts, 2);

		// Gemini's contract authenticates with x-goog-api-key and answers errors in Google's shape.
		const invalid = await app.request("/v1beta/decisions", {
			method: "POST",
			headers: {
				"x-goog-api-key": virtualKey.rawKey,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: publicModel,
				input: "x",
				questions: { "bad key": { type: "noul", instructions: "?" } },
			}),
		});
		assert.equal(invalid.status, 400);
		const error = (await invalid.json()) as {
			error: { code: number; status: string };
		};
		assert.equal(error.error.code, 400);
		assert.equal(error.error.status, "INVALID_ARGUMENT");
	} finally {
		if (virtualKey) {
			await invalidateVirtualKey(virtualKey.row.keyHash);
			await deleteVirtualKey(virtualKey.row.id);
		}
		for (const deploymentId of deploymentIds) {
			await deleteDeployment(deploymentId);
		}
	}
});
