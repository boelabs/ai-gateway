import { buildDocsExport, readDocsContent } from "../docs/export.ts";
import { createHash } from "node:crypto";
import type { Context } from "hono";

/**
 * `GET /docs/export.json` — the documentation source boelabs.com renders (contract in AGENTS.md).
 * Public and unauthenticated, like `/v1/models`: it is the same text as the public repository.
 *
 * The pages ship inside the image and cannot change while the process runs, so the document is read
 * and serialized once; every later request is the same bytes, answered with 304 when the caller
 * already holds them.
 */
interface Serialized {
	body: string;
	etag: string;
}

let serialized: Promise<Serialized> | undefined;

async function serialize(): Promise<Serialized> {
	const body = JSON.stringify(
		buildDocsExport(await readDocsContent(), new Date()),
	);
	const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
	return { body, etag };
}

const CACHE_CONTROL =
	"public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

export async function docsExportHandler(c: Context): Promise<Response> {
	serialized ??= serialize().catch((error: unknown) => {
		serialized = undefined;
		throw error;
	});
	const { body, etag } = await serialized;

	c.header("cache-control", CACHE_CONTROL);
	c.header("etag", etag);
	if (c.req.header("if-none-match") === etag) {
		return c.body(null, 304);
	}
	c.header("content-type", "application/json; charset=utf-8");
	return c.body(body, 200);
}
