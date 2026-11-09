import { docsExportHandler, etagMatches } from "./docs.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";

const app = new Hono().get("/docs/export.json", docsExportHandler);

test("GET /docs/export.json serves cacheable JSON and answers 304 to its ETag", async () => {
	const first = await app.request("/docs/export.json");
	assert.equal(first.status, 200);
	assert.match(first.headers.get("content-type") ?? "", /application\/json/u);
	assert.match(first.headers.get("cache-control") ?? "", /public/u);
	const body = (await first.json()) as { schema: number; pages: unknown[] };
	assert.equal(body.schema, 1);
	assert.ok(body.pages.length > 0);

	const etag = first.headers.get("etag") ?? "";
	assert.notEqual(etag, "");
	const again = await app.request("/docs/export.json", {
		headers: { "if-none-match": etag },
	});
	assert.equal(again.status, 304);
	assert.equal(await again.text(), "");
});

test("If-None-Match matches weakly, across lists, and on *", async () => {
	const etag = '"abc"';
	assert.ok(etagMatches('"abc"', etag));
	assert.ok(etagMatches('W/"abc"', etag));
	assert.ok(etagMatches('"other", W/"abc"', etag));
	assert.ok(etagMatches("*", etag));
	assert.ok(!etagMatches('"abd"', etag));
	assert.ok(!etagMatches(undefined, etag));

	// What a client sends after Cloudflare compressed the response and weakened the tag.
	const first = await app.request("/docs/export.json");
	const weakened = `W/${first.headers.get("etag") ?? ""}`;
	const again = await app.request("/docs/export.json", {
		headers: { "if-none-match": weakened },
	});
	assert.equal(again.status, 304);
});
