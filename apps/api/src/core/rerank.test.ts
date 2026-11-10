import { withEstimatedSearchUnits } from "./rerank.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("search units are derived from documents per unit when the upstream omits them", () => {
	assert.deepEqual(
		withEstimatedSearchUnits(null, 250, { documentsPerSearchUnit: 100 }),
		{
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			searchUnits: 3,
			estimated: true,
		},
	);
});

test("reported search units and models without a unit rule are left alone", () => {
	const reported = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		searchUnits: 1,
	};
	assert.equal(
		withEstimatedSearchUnits(reported, 250, { documentsPerSearchUnit: 100 }),
		reported,
	);
	assert.equal(withEstimatedSearchUnits(null, 250, undefined), null);
});
