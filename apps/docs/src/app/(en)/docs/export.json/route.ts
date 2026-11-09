import { buildDocsExport, readDocsContent } from "#/lib/export.ts";
import { join } from "node:path";

/**
 * `GET /docs/export.json` — the documentation source for boelabs.com/docs (contract in AGENTS.md).
 *
 * Rendered per request rather than prerendered, because `assetsBase` comes from `DOCS_SITE_URL`
 * and the image carries no configuration. The pages themselves cannot change while the server
 * runs, so they are read once — `outputFileTracingIncludes` ships `content/docs` beside the
 * standalone server — and every response after the first is a serialization.
 */
let content: ReturnType<typeof load> | undefined;

function load() {
	return readDocsContent(join(process.cwd(), "content/docs")).then((read) => ({
		read,
		at: new Date(),
	}));
}

export async function GET(request: Request) {
	content ??= load().catch((error: unknown) => {
		content = undefined;
		throw error;
	});
	const { read, at } = await content;

	const site = process.env.DOCS_SITE_URL?.trim();
	const assetsBase = site ? new URL(site).origin : new URL(request.url).origin;

	return Response.json(buildDocsExport(read, { assetsBase, generatedAt: at }), {
		headers: {
			"Cache-Control":
				"public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
		},
	});
}
