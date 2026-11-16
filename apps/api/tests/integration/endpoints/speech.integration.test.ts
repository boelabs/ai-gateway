import { jsonResponse, withStubbedFetch } from "#test-support/fetch.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { makeOpenAIContractTestApp } from "#test-support/app.ts";
import { createDeployment, deleteDeployment } from "#db/repos/deployments.ts";
import { pcmToWav, readWav } from "#core/speech.ts";
import { speechHandler } from "#endpoints/speech.ts";
import { eventually } from "#test-support/wait.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { env } from "#config/env.ts";
import { test } from "node:test";

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
	instance.post("/v1/audio/speech", speechHandler);
});

function speak(body: Record<string, unknown>, requestId: string) {
	return app.request("/v1/audio/speech", {
		method: "POST",
		headers: {
			authorization: `Bearer ${env.MASTER_KEY}`,
			"content-type": "application/json",
			"x-request-id": requestId,
		},
		body: JSON.stringify(body),
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

const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);

test("/v1/audio/speech returns Gemini's audio and bills its audio tokens at the tier served", {
	skip,
}, async () => {
	const row = await createDeployment({
		publicModel: `speech-${randomUUID()}`,
		adapterKey: "googleaistudio",
		upstreamModel: "gemini-3.8-flash-tts",
		credentials: { apiKey: "test-key" },
	});
	try {
		const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
		const requestId = randomUUID();
		await withStubbedFetch(
			(input, init) => {
				sent.push({
					url: String(input),
					body: JSON.parse(String(init?.body)),
				});
				return jsonResponse({
					candidates: [
						{
							content: {
								parts: [
									{
										inlineData: {
											mimeType: "audio/wav",
											data: Buffer.from(pcmToWav(pcm, 24_000)).toString(
												"base64",
											),
										},
									},
								],
							},
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 0,
						candidatesTokenCount: 1_000_000,
						totalTokenCount: 1_000_000,
						candidatesTokensDetails: [
							{ modality: "AUDIO", tokenCount: 1_000_000 },
						],
					},
				});
			},
			async () => {
				const response = await speak(
					{
						model: `${row.publicModel}:flex`,
						input: "Hello there.",
						voice: "Kore",
					},
					requestId,
				);
				assert.equal(response.status, 200, await response.clone().text());
				assert.equal(response.headers.get("content-type"), "audio/wav");
				assert.deepEqual(
					readWav(new Uint8Array(await response.arrayBuffer()))?.pcm,
					pcm,
				);
			},
		);
		assert.equal(sent.length, 1);
		assert.match(sent[0]?.url ?? "", /gemini-3\.8-flash-tts:generateContent$/u);
		assert.equal(sent[0]?.body.service_tier, "flex");
		const detail = await operation(requestId);
		// 1M audio output tokens of gemini-3.8-flash-tts: $9.00 standard, $4.50 at Flex (through 2026).
		const expected =
			Date.now() < Date.parse("2027-01-01T00:00:00Z") ? 450 : 900;
		assert.equal(Number(detail.consumerCostCents), expected);
	} finally {
		await deleteDeployment(row.id);
	}
});

test("/v1/audio/speech refuses a format the model cannot return, before any upstream call", {
	skip,
}, async () => {
	const row = await createDeployment({
		publicModel: `speech-${randomUUID()}`,
		adapterKey: "googleaistudio",
		upstreamModel: "gemini-3.8-flash-lite-tts",
		credentials: { apiKey: "test-key" },
	});
	try {
		let calls = 0;
		await withStubbedFetch(
			() => {
				calls++;
				return jsonResponse({});
			},
			async () => {
				const response = await speak(
					{
						model: row.publicModel,
						input: "Hello there.",
						voice: "Kore",
						response_format: "mp3",
					},
					randomUUID(),
				);
				assert.equal(response.status, 400);
				const body = (await response.json()) as {
					error: { param: string };
				};
				assert.equal(body.error.param, "response_format");
			},
		);
		assert.equal(calls, 0);
	} finally {
		await deleteDeployment(row.id);
	}
});
