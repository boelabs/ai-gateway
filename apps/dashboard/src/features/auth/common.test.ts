import { safeNextPath } from "./common.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("sign-in only returns to a path on this dashboard", () => {
	assert.equal(safeNextPath("/logs?page=2"), "/logs?page=2");
	assert.equal(safeNextPath("/a/../models"), "/models");
	for (const hostile of [
		"//evil.example",
		"/\\evil.example",
		"/\tevil",
		"https://evil.example",
		"javascript:alert(1)",
		"/%0a",
		undefined,
		["/x"],
	]) {
		assert.notEqual(safeNextPath(hostile).startsWith("//"), true);
		assert.equal(
			new URL(safeNextPath(hostile), "http://d.test").host,
			"d.test",
		);
	}
	assert.equal(safeNextPath("//evil.example"), "/");
	assert.equal(safeNextPath("/\\evil.example"), "/");
});
