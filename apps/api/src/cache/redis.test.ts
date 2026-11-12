import { redisTlsOptions } from "./redis.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("rediss:// verifies the certificate unless told otherwise", () => {
	assert.deepEqual(
		redisTlsOptions({ url: "redis://cache:6379", insecure: false }),
		{},
	);
	assert.deepEqual(
		redisTlsOptions({ url: "rediss://cache:6380", insecure: false }),
		{ tls: { rejectUnauthorized: true } },
	);
	assert.deepEqual(
		redisTlsOptions({ url: "rediss://cache:6380", ca: "PEM", insecure: false }),
		{ tls: { rejectUnauthorized: true, ca: "PEM" } },
	);
	assert.deepEqual(
		redisTlsOptions({ url: "rediss://cache:6380", insecure: true }),
		{ tls: { rejectUnauthorized: false } },
	);
});
