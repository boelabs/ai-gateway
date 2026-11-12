import nextConfig from "../../../next.config.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("every response carries the dashboard's security headers", async () => {
	const rules = (await nextConfig.headers?.()) ?? [];
	const all = rules.find((rule) => rule.source === "/(.*)");
	const headers = new Map(all?.headers.map(({ key, value }) => [key, value]));
	const csp = headers.get("Content-Security-Policy") ?? "";
	assert.match(csp, /frame-ancestors 'none'/u);
	assert.match(csp, /object-src 'none'/u);
	assert.match(csp, /script-src 'self'/u);
	assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
	assert.equal(
		headers.get("Referrer-Policy"),
		"strict-origin-when-cross-origin",
	);
});
