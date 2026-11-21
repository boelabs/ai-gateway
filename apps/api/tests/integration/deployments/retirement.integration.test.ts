import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";

import "#adapters/index.ts";

import { createDeployment, updateDeployment } from "#deployments/service.ts";
import { redisAvailable, pgAvailable } from "#test-support/infra.ts";
import { GatewayError } from "#core/errors.ts";

import {
	createDeployment as insertDeployment,
	deleteDeployment,
} from "#db/repos/deployments.ts";

const skip = (await Promise.all([pgAvailable(), redisAvailable()])).every(
	Boolean,
)
	? false
	: "Postgres/Redis unavailables";

// Retired on 2026-10-22 in the Google AI Studio catalog; gemini-omni-1.2-flash is in service.
const RETIRED = "veo-3.1-generate-preview";
const IN_SERVICE = "gemini-omni-1.2-flash";
const adapterKey = "googleaistudio";

function isRetiredRefusal(error: unknown): boolean {
	return (
		GatewayError.is(error) &&
		error.code === "model_retired" &&
		error.httpStatus === 400 &&
		error.param === "upstreamModel"
	);
}

test("deployments: a retired catalog model cannot be deployed or switched to", {
	skip,
}, async () => {
	const publicModel = `itest-retired-${randomUUID()}`;
	const ids: string[] = [];
	try {
		await assert.rejects(
			createDeployment({
				publicModel,
				adapterKey,
				upstreamModel: RETIRED,
				credentials: { apiKey: "test-key" },
			}),
			isRetiredRefusal,
		);

		const live = await createDeployment({
			publicModel,
			adapterKey,
			upstreamModel: IN_SERVICE,
			credentials: { apiKey: "test-key" },
		});
		ids.push(live.row.id);
		await assert.rejects(
			updateDeployment(live.row.id, { upstreamModel: RETIRED }),
			isRetiredRefusal,
		);

		// One created before the model retired keeps working: it can still be edited or disabled.
		const legacy = await insertDeployment({
			publicModel,
			adapterKey,
			upstreamModel: RETIRED,
			credentials: { apiKey: "test-key" },
			label: null,
			failureDomain: null,
			metadata: {},
			catalogEntry: null,
			pricing: null,
			transportOverrides: {},
			executionPolicyOverrides: {},
		});
		ids.push(legacy.id);
		const edited = await updateDeployment(legacy.id, {
			label: "legacy",
			enabled: false,
		});
		assert.equal(edited.row.label, "legacy");
		assert.equal(edited.row.enabled, false);
	} finally {
		for (const id of ids) {
			await deleteDeployment(id);
		}
	}
});
