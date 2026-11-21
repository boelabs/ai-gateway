import {
	catalogRetiredOn,
	explainRetiredModel,
	retiredModelRefusal,
	utcToday,
} from "./retirement.ts";
import { GatewayError } from "#core/errors.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

// veo-3.1-generate-preview: retiresOn 2026-10-22 in the Google AI Studio catalog.
const veo = {
	adapterKey: "googleaistudio",
	upstreamModel: "veo-3.1-generate-preview",
};

test("a catalog model counts as retired from its retirement day on", () => {
	assert.equal(
		catalogRetiredOn(veo.adapterKey, veo.upstreamModel, "2026-10-21"),
		undefined,
	);
	assert.equal(
		catalogRetiredOn(veo.adapterKey, veo.upstreamModel, "2026-10-22"),
		"2026-10-22",
	);
	assert.equal(
		catalogRetiredOn("googleaistudio", "gemini-omni-1.2-flash", "2030-01-01"),
		undefined,
	);
	assert.equal(
		catalogRetiredOn("googleaistudio", "not-in-the-catalog", "2030-01-01"),
		undefined,
	);
	assert.equal(utcToday(new Date("2026-11-20T23:30:00-05:00")), "2026-11-21");
});

test("a provider's not-found for a retired model is explained", () => {
	const upstream = new GatewayError({
		class: "not_found",
		message: "Model is not found: models/veo-3.1-generate-preview",
		provider: { status: 404, body: { error: { code: 404 } } },
	});
	const explained = explainRetiredModel(upstream, veo, "2026-11-20");
	assert.equal(explained.httpStatus, 404);
	assert.equal(explained.code, "model_retired");
	assert.equal(
		explained.publicMessage,
		"The provider retired the model `veo-3.1-generate-preview` on 2026-10-22.",
	);
	assert.equal(explained.failureKind, upstream.failureKind);
	assert.deepEqual(explained.provider, upstream.provider);
	assert.match(explained.message, /Model is not found/u);
});

test("other errors, models still in service and custom entries are left alone", () => {
	const notFound = new GatewayError({ class: "not_found", message: "nope" });
	const server = new GatewayError({ class: "server", message: "boom" });
	assert.equal(explainRetiredModel(server, veo, "2026-11-20"), server);
	assert.equal(explainRetiredModel(notFound, veo, "2026-10-21"), notFound);
	assert.equal(
		explainRetiredModel(
			notFound,
			{ ...veo, catalogEntry: { operations: {} } },
			"2026-11-20",
		),
		notFound,
	);
});

test("a retired model cannot be deployed", () => {
	const refusal = retiredModelRefusal(
		veo.adapterKey,
		veo.upstreamModel,
		"2026-11-20",
	);
	assert.equal(refusal?.httpStatus, 400);
	assert.equal(refusal?.code, "model_retired");
	assert.equal(refusal?.param, "upstreamModel");
	assert.match(
		refusal?.publicMessage ?? "",
		/retired "veo-3\.1-generate-preview" on 2026-10-22/u,
	);
	assert.equal(
		retiredModelRefusal(veo.adapterKey, veo.upstreamModel, "2026-10-21"),
		undefined,
	);
});
