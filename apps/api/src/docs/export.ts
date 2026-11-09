import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The documentation export: every page and navigation file under the repository's `docs/`, as
 * written, for boelabs.com/docs. This repository publishes no documentation site of its own;
 * boelabs.com compiles the MDX with its own components and styles.
 *
 * The contract is shared by every Boelabs product; see AGENTS.md ("Documentation") before
 * changing a field. Pure apart from reading files, so the route and the tests build the same
 * document.
 */

export type DocsLocale = "en" | "es";

export interface DocsMeta {
	/** The folder under `docs/`, route groups included; `""` is `docs/` itself. */
	dir: string;
	locale: DocsLocale;
	data: Record<string, unknown>;
}

export interface DocsPage {
	/** The public slug: route groups dropped, `index` is its folder (`""` for the home page). */
	path: string;
	locale: DocsLocale;
	/** The file under `docs/`. */
	file: string;
	frontmatter: Record<string, unknown>;
	mdx: string;
}

export interface DocsContent {
	meta: DocsMeta[];
	pages: DocsPage[];
}

export interface DocsExport extends DocsContent {
	schema: 1;
	product: "ai-gateway";
	generatedAt: string;
	apiVersion: string | null;
	defaultLocale: DocsLocale;
	locales: DocsLocale[];
	openapi: string | null;
	assetsBase: string;
}

/** Where `docs/` sits: the repository root, and `/app/docs` in the gateway's image. */
export const DOCS_ROOT = fileURLToPath(
	new URL("../../../../docs", import.meta.url),
);

const REPOSITORY_RAW =
	"https://raw.githubusercontent.com/boelabs/ai-gateway/main";

/** The gateway does not serve its spec; the public repository is the canonical copy. */
export const OPENAPI_URL = `${REPOSITORY_RAW}/apps/api/openapi.yaml`;

/**
 * What a relative asset path in a page resolves against. The gateway serves no static files, so an
 * image committed beside the MDX is published from the public repository.
 */
export const ASSETS_BASE = `${REPOSITORY_RAW}/docs/`;

const frontmatterBlock = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const routeGroup = /^\(.+\)$/u;

function localeOf(name: string, extension: string): DocsLocale {
	return name.endsWith(`.es${extension}`) ? "es" : "en";
}

/** `(docs)/(get-started)/quickstart.es.mdx` -> `quickstart`; `(docs)/index.mdx` -> `""`. */
export function pathOf(file: string): string {
	const parts = file.replace(/(?:\.es)?\.mdx$/u, "").split("/");
	if (parts.at(-1) === "index") {
		parts.pop();
	}
	return parts.filter((part) => !routeGroup.test(part)).join("/");
}

function splitFrontmatter(source: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	const match = frontmatterBlock.exec(source);
	if (!match) {
		return { frontmatter: {}, body: source };
	}
	const data: unknown = parse(match[1] ?? "");
	return {
		frontmatter:
			data && typeof data === "object" ? (data as Record<string, unknown>) : {},
		body: source.slice(match[0].length).replace(/^\n+/u, ""),
	};
}

/** Reads `docs/` (or `root`) into export entries, sorted by file. Drafts are left out. */
export async function readDocsContent(
	root: string = DOCS_ROOT,
): Promise<DocsContent> {
	const files = (await readdir(root, { recursive: true }))
		.map((entry) => entry.replaceAll("\\", "/"))
		.sort();

	const meta: DocsMeta[] = [];
	const pages: DocsPage[] = [];
	for (const file of files) {
		const name = file.split("/").at(-1) ?? "";
		const dir = file.split("/").slice(0, -1).join("/");
		if (name === "meta.json" || name === "meta.es.json") {
			const data = JSON.parse(await readFile(join(root, file), "utf8"));
			meta.push({ dir, locale: localeOf(name, ".json"), data: data ?? {} });
			continue;
		}
		if (!name.endsWith(".mdx")) {
			continue;
		}
		const source = (await readFile(join(root, file), "utf8")).replaceAll(
			"\r\n",
			"\n",
		);
		const { frontmatter, body } = splitFrontmatter(source);
		if (frontmatter.draft === true) {
			continue;
		}
		pages.push({
			path: pathOf(file),
			locale: localeOf(name, ".mdx"),
			file,
			frontmatter,
			mdx: body,
		});
	}
	return { meta, pages };
}

export function buildDocsExport(
	content: DocsContent,
	generatedAt: Date,
): DocsExport {
	return {
		schema: 1,
		product: "ai-gateway",
		generatedAt: generatedAt.toISOString(),
		apiVersion: null,
		defaultLocale: "en",
		locales: ["en", "es"],
		openapi: OPENAPI_URL,
		assetsBase: ASSETS_BASE,
		meta: content.meta,
		pages: content.pages,
	};
}
