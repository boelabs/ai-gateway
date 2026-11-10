import { gatewayClientHeaders } from "./forwarded.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("the client's forwarded address and user agent reach the gateway, nothing else", () => {
	const headers = gatewayClientHeaders(
		new Headers({
			"x-forwarded-for": "203.0.113.9",
			"user-agent": "Mozilla/5.0",
			"x-real-ip": "198.51.100.1",
			authorization: "Bearer secret",
		}),
	);
	assert.deepEqual([...headers.entries()].sort(), [
		["user-agent", "Mozilla/5.0"],
		["x-forwarded-for", "203.0.113.9"],
	]);
});
