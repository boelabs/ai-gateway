import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { type UsageQuota, route } from "#router/index.ts";
import { GatewayError } from "#core/errors.ts";
import type { Usage } from "#core/usage.ts";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";

import "#adapters/index.ts";

import {
	type DeploymentRow,
	createDeployment,
	deleteDeployment,
} from "#db/repos/deployments.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

const created: DeploymentRow[] = [];

after(async () => {
	await Promise.all(created.map((row) => deleteDeployment(row.id)));
});

async function deployment(): Promise<DeploymentRow> {
	const row = await createDeployment({
		publicModel: `settle-${randomUUID()}`,
		adapterKey: "openaicompatible",
		upstreamModel: `text-${randomUUID()}`,
		credentials: { apiKey: "test", baseUrl: "https://example.test/v1" },
		catalogEntry: {
			operations: {
				"text.generate": {
					capabilities: {
						tools: false,
						vision: false,
						reasoning: false,
						structuredOutputs: false,
					},
				},
			},
		},
	});
	created.push(row);
	return row;
}

function recordingQuota() {
	const events: Array<{ kind: "settle"; usage: Usage } | { kind: "release" }> =
		[];
	const quota: UsageQuota = {
		assertCandidate: () => {
			/* intentionally empty */
		},
		reserve: () =>
			Promise.resolve({
				settle: (usage) => {
					events.push({ kind: "settle", usage });
					return Promise.resolve();
				},
				release: () => {
					events.push({ kind: "release" });
					return Promise.resolve();
				},
			}),
	};
	return { events, quota };
}

const RESERVATION = { inputTokens: 300, outputTokens: 4096 };

test("router: a stream cut before its usage frame settles reserved input plus observed output", {
	skip,
}, async () => {
	const row = await deployment();
	const { events, quota } = recordingQuota();
	const routed = await route(
		row.publicModel,
		"chat",
		{
			clientSignal: new AbortController().signal,
			requestId: randomUUID(),
			tokenReservation: () => RESERVATION,
			usageQuota: quota,
		},
		() =>
			Promise.resolve({
				observation: { outputBytes: 42, usage: null, terminal: null },
			}),
	);
	const settled = await routed.finish(
		null,
		undefined,
		new GatewayError({
			class: "server",
			code: "upstream_stream_error",
			message: "connection reset",
			failureKind: "transient",
		}),
	);
	assert.deepEqual(settled, {
		promptTokens: 300,
		completionTokens: 42,
		totalTokens: 342,
		estimated: true,
	});
	assert.deepEqual(events, [{ kind: "settle", usage: settled }]);
	assert.equal(routed.attemptLog[0]?.usage?.estimated, true);
});

test("router: reported usage settles as reported", { skip }, async () => {
	const row = await deployment();
	const { events, quota } = recordingQuota();
	const routed = await route(
		row.publicModel,
		"chat",
		{
			clientSignal: new AbortController().signal,
			requestId: randomUUID(),
			tokenReservation: () => RESERVATION,
			usageQuota: quota,
		},
		() =>
			Promise.resolve({
				terminal: { outcome: "completed", reason: "stop", usage: null },
			}),
	);
	const usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
	assert.deepEqual(await routed.finish(usage), usage);
	assert.deepEqual(events, [{ kind: "settle", usage }]);
});

test("router: call types settled elsewhere release instead of estimating", {
	skip,
}, async () => {
	const row = await deployment();
	const { events, quota } = recordingQuota();
	const routed = await route(
		row.publicModel,
		"chat",
		{
			clientSignal: new AbortController().signal,
			requestId: randomUUID(),
			tokenReservation: () => RESERVATION,
			usageQuota: quota,
			unreportedUsage: "release",
		},
		() =>
			Promise.resolve({
				terminal: { outcome: "completed", reason: "stop", usage: null },
			}),
	);
	assert.equal(await routed.finish(null), null);
	assert.deepEqual(events, [{ kind: "release" }]);
});

test("router: an upstream that never accepted the request releases the reservation", {
	skip,
}, async () => {
	const row = await deployment();
	const { events, quota } = recordingQuota();
	await assert.rejects(
		route(
			row.publicModel,
			"chat",
			{
				clientSignal: new AbortController().signal,
				requestId: randomUUID(),
				tokenReservation: () => RESERVATION,
				usageQuota: quota,
			},
			() =>
				Promise.reject(
					new GatewayError({
						class: "bad_request",
						message: "rejected",
						status: 400,
					}),
				),
		),
	);
	assert.deepEqual(events, [{ kind: "release" }]);
});
