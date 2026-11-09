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

/**
 * `If-None-Match` uses the weak comparison (RFC 9110 §13.1.2): a `W/` prefix is ignored, and the
 * header may list several tags or be `*`. A CDN that compresses the body, as Cloudflare does, hands
 * the client a weakened copy of the tag, so an exact string match would never answer 304.
 */
export function etagMatches(header: string | undefined, etag: string): boolean {
	if (!header) {
		return false;
	}
	const opaque = (tag: string) => tag.trim().replace(/^W\//u, "");
	return header
		.split(",")
		.some((tag) => tag.trim() === "*" || opaque(tag) === opaque(etag));
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
	if (etagMatches(c.req.header("if-none-match"), etag)) {
		return c.body(null, 304);
	}
	c.header("content-type", "application/json; charset=utf-8");
	return c.body(body, 200);
}
