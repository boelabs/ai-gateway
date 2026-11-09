import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * The documentation export: every page and navigation file, as written, for boelabs.com/docs.
 *
 * boelabs.com compiles the MDX with its own components and styles, so this hands over the source,
 * not the rendered output. The contract is shared by every Boelabs product; see AGENTS.md
 * ("Documentation export") before changing a field.
 *
 * Pure on purpose — no Next import, no environment read — so the route and the tests build the
 * same document from the same files.
 */

export type ExportLocale = "en" | "es";

export interface ExportMeta {
	/** The folder under `content/docs`, route groups included; `""` is `content/docs` itself. */
	dir: string;
	locale: ExportLocale;
	data: Record<string, unknown>;
}

export interface ExportPage {
	/** The public slug, as Fumadocs builds it: route groups dropped, `index` is its folder. */
	path: string;
	locale: ExportLocale;
	/** The file under `content/docs`. */
	file: string;
	frontmatter: Record<string, unknown>;
	mdx: string;
}

export interface DocsContent {
	meta: ExportMeta[];
	pages: ExportPage[];
}

export interface DocsExport extends DocsContent {
	schema: 1;
	product: "ai-gateway";
	generatedAt: string;
	apiVersion: string | null;
	defaultLocale: ExportLocale;
	locales: ExportLocale[];
	openapi: string | null;
	assetsBase: string;
}

/** The gateway does not serve its spec; the public repository is the canonical copy. */
export const OPENAPI_URL =
	"https://raw.githubusercontent.com/boelabs/ai-gateway/main/apps/api/openapi.yaml";

const frontmatterBlock = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const routeGroup = /^\(.+\)$/u;
// Spanish pages link to `/es/docs/...` on this site; the export speaks in `/docs/...` only.
const spanishLink = /(\]\(|href=")\/es\/docs(?=[/)#?"])/gu;

function localeOf(name: string, extension: string): ExportLocale {
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

/** Reads `content/docs` (or `root`) into export entries, sorted by file. Drafts are left out. */
export async function readDocsContent(root: string): Promise<DocsContent> {
	const files = (await readdir(root, { recursive: true }))
		.map((entry) => entry.replaceAll("\\", "/"))
		.sort();

	const meta: ExportMeta[] = [];
	const pages: ExportPage[] = [];
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
		const locale = localeOf(name, ".mdx");
		pages.push({
			path: pathOf(file),
			locale,
			file,
			frontmatter,
			mdx: locale === "es" ? body.replace(spanishLink, "$1/docs") : body,
		});
	}
	return { meta, pages };
}

export function buildDocsExport(
	content: DocsContent,
	options: { assetsBase: string; generatedAt: Date },
): DocsExport {
	return {
		schema: 1,
		product: "ai-gateway",
		generatedAt: options.generatedAt.toISOString(),
		apiVersion: null,
		defaultLocale: "en",
		locales: ["en", "es"],
		openapi: OPENAPI_URL,
		assetsBase: options.assetsBase,
		meta: content.meta,
		pages: content.pages,
	};
}
