import { concurrentIndexName } from "./migrations.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the concurrent track takes one idempotent concurrent index build per file", () => {
	assert.equal(
		concurrentIndexName(
			"0001_x.sql",
			'CREATE INDEX CONCURRENTLY IF NOT EXISTS "ops_ended_idx" ON t (ended_at);\n',
		),
		"ops_ended_idx",
	);
	for (const statement of [
		"CREATE INDEX ops_idx ON t (a);",
		"CREATE INDEX CONCURRENTLY ops_idx ON t (a);",
		'CREATE INDEX CONCURRENTLY IF NOT EXISTS "a" ON t (a); DROP TABLE t;',
	]) {
		assert.throws(() => concurrentIndexName("bad.sql", statement));
	}
});
