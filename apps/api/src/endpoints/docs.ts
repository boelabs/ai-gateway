import { createHash } from "node:crypto";
import type { Context } from "hono";

import {
	type DocsContent,
	buildDocsExport,
	readDocsContent,
} from "../docs/export.ts";

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

/**
 * The ETag names the content, not this serialization: `generatedAt` differs per process, and every
 * replica serving the same pages must answer the same tag, or a CDN in front of several of them
 * would keep refetching a document that never changed.
 */
export function docsEtag(content: DocsContent): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(buildDocsExport(content, new Date(0))))
		.digest("base64url");
	return `"${digest.slice(0, 27)}"`;
}

async function serialize(): Promise<Serialized> {
	const content = await readDocsContent();
	const body = JSON.stringify(buildDocsExport(content, new Date()));
	return { body, etag: docsEtag(content) };
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
