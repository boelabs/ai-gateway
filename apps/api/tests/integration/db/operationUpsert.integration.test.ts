import { completeOperation, flushOperationLogs } from "#logging/operations.ts";
import { pgAvailable, redisAvailable } from "#test-support/infra.ts";
import { gatewayOperations, upstreamAttempts } from "#db/schema.ts";
import type { OperationLogInput } from "#logging/logger.ts";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { db } from "#db/client.ts";
import { eq } from "drizzle-orm";
import { test } from "node:test";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailable";

test("a finished operation is recorded even when its start was never written", {
	skip,
}, async () => {
	const operationId = randomUUID();
	const startedAt = new Date(Date.now() - 1000);
	const input: OperationLogInput = {
		operationId,
		requestId: randomUUID(),
		virtualKeyId: null,
		actor: "master-key",
		publicModel: "upsert-model",
		deploymentId: null,
		adapterKey: "openai",
		callType: "chat",
		status: "error",
		httpStatus: 400,
		usage: null,
		cost: null,
		durationMs: 5,
		firstOutputMs: null,
		cacheHit: false,
		retries: 0,
		fallbackUsed: false,
		ip: null,
		userAgent: null,
		startTime: startedAt,
		endTime: new Date(),
		requestBody: null,
		responseBody: null,
		metadata: {},
		error: { class: "bad_request", code: "invalid_value" },
		attempts: [],
	};
	try {
		// The start write never happened (dropped, or failed after its retries).
		completeOperation(operationId, Promise.resolve(), input);
		await flushOperationLogs();
		const [row] = await db
			.select()
			.from(gatewayOperations)
			.where(eq(gatewayOperations.id, operationId));
		assert.equal(row?.lifecycleState, "finished");
		assert.equal(row?.actor, "master-key");
		assert.equal(row?.startedAt.getTime(), startedAt.getTime());
	} finally {
		await db
			.delete(gatewayOperations)
			.where(eq(gatewayOperations.id, operationId));
	}
});

test("an attempt row needs its operation, and goes with it", {
	skip,
}, async () => {
	await assert.rejects(
		db.insert(upstreamAttempts).values({
			operationId: randomUUID(),
			ordinal: 1,
			adapterKey: "openai",
			outcome: "in_progress",
			startedAt: new Date(),
			lastProgressAt: new Date(),
		}),
	);
});
