import { buildDocsExport, readDocsContent } from "../src/lib/export.ts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

/**
 * `/docs/export.json` is read by boelabs.com, which compiles the MDX with its own closed set of
 * components. A field that changes shape, a draft that leaks, or a component it does not have
 * breaks a site in another repository, so all three are checked here rather than discovered there.
 */
const root = resolve(import.meta.dir, "../content/docs");

const locale = z.enum(["en", "es"]);
const contract = z.strictObject({
	schema: z.literal(1),
	product: z.literal("ai-gateway"),
	generatedAt: z.iso.datetime(),
	apiVersion: z.string().nullable(),
	defaultLocale: z.literal("en"),
	locales: z.tuple([z.literal("en"), z.literal("es")]),
	openapi: z.url().nullable(),
	assetsBase: z.url(),
	meta: z.array(
		z.strictObject({
			dir: z.string(),
			locale,
			data: z.record(z.string(), z.unknown()),
		}),
	),
	pages: z.array(
		z.strictObject({
			path: z.string().regex(/^(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/u),
			locale,
			file: z.string().regex(/\.mdx$/u),
			frontmatter: z.looseObject({
				title: z.string().min(1),
				description: z.string().min(1),
			}),
			mdx: z.string().min(1),
		}),
	),
});

/** What boelabs.com renders: these components with these props, and nothing else. */
const supported: Record<string, string[]> = {
	Callout: ["type", "title"],
	Tabs: ["items"],
	Tab: ["value"],
	Steps: [],
	Step: [],
	Cards: [],
	Card: ["title", "href"],
};

const fence = /^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gmu;
const inlineCode = /`[^`\n]+`/gu;
const element = /<\/?([A-Za-z][\w.]*)([^>]*)>/gu;
const attribute = /([A-Za-z][\w-]*)=/gu;

/** The MDX a reader sees as markup: code blocks and inline code removed. */
function markup(mdx: string): string {
	return mdx.replace(fence, "").replace(inlineCode, "");
}

async function exported() {
	return buildDocsExport(await readDocsContent(root), {
		assetsBase: "https://docs.example.com",
		generatedAt: new Date(),
	});
}

describe("docs export", () => {
	it("matches the shared contract", async () => {
		const result = contract.safeParse(await exported());
		expect(result.success ? [] : result.error.issues).toEqual([]);
	});

	it("exports every page and folder in both languages", async () => {
		const { pages, meta } = await exported();
		const en = pages.filter((page) => page.locale === "en");
		const es = pages.filter((page) => page.locale === "es");
		expect(en.length).toBeGreaterThan(0);
		expect(es.map((page) => page.path).sort()).toEqual(
			en.map((page) => page.path).sort(),
		);
		expect(new Set(en.map((page) => page.path)).size).toBe(en.length);
		expect(
			meta.filter((entry) => entry.locale === "es").map((entry) => entry.dir),
		).toEqual(
			meta.filter((entry) => entry.locale === "en").map((entry) => entry.dir),
		);
	});

	it("gives every English page its public path", async () => {
		for (const page of (await exported()).pages) {
			if (page.locale !== "en") {
				continue;
			}
			const kept = page.file
				.replace(/\.mdx$/u, "")
				.split("/")
				.filter((part) => !/^\(.+\)$/u.test(part));
			const expected = kept.at(-1) === "index" ? kept.slice(0, -1) : kept;
			expect({ file: page.file, path: page.path }).toEqual({
				file: page.file,
				path: expected.join("/"),
			});
		}
		const paths = (await exported()).pages.map((page) => page.path);
		for (const path of ["", "quickstart", "api-overview", "providers-openai"]) {
			expect(paths).toContain(path);
		}
	});

	it("ships the MDX body without frontmatter, linking to /docs paths that exist", async () => {
		const { pages } = await exported();
		const paths = new Set(pages.map((page) => page.path));
		for (const page of pages) {
			expect(page.mdx.startsWith("---")).toBe(false);
			for (const match of page.mdx.matchAll(
				/\]\((\/[^\s)]*)\)|href="(\/[^"]*)"/gu,
			)) {
				const link = match[1] ?? match[2] ?? "";
				expect({ file: page.file, link }).toEqual({
					file: page.file,
					link: link.startsWith("/docs") ? link : "/docs…",
				});
				const target = link.replace(/^\/docs\/?/u, "").replace(/[#?].*$/u, "");
				expect({ file: page.file, link, exists: paths.has(target) }).toEqual({
					file: page.file,
					link,
					exists: true,
				});
			}
		}
	});

	it("leaves drafts out", async () => {
		const dir = await mkdtemp(join(tmpdir(), "docs-export-"));
		try {
			await mkdir(join(dir, "(docs)"));
			await writeFile(
				join(dir, "(docs)", "published.mdx"),
				"---\ntitle: Published\ndescription: Shown.\n---\n\nBody.\n",
			);
			await writeFile(
				join(dir, "(docs)", "unfinished.mdx"),
				"---\ntitle: Unfinished\ndescription: Hidden.\ndraft: true\n---\n\nBody.\n",
			);
			const { pages } = await readDocsContent(dir);
			expect(pages.map((page) => page.path)).toEqual(["published"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		for (const page of (await exported()).pages) {
			expect(page.frontmatter.draft).toBeUndefined();
		}
	});
});

describe("published MDX", () => {
	it("uses only the components boelabs.com supports, with their props", async () => {
		for (const page of (await exported()).pages) {
			for (const [, name = "", attributes = ""] of markup(page.mdx).matchAll(
				element,
			)) {
				const props = [...attributes.matchAll(attribute)].map((m) => m[1]);
				expect({ file: page.file, name, props }).toEqual({
					file: page.file,
					name: name in supported ? name : "a supported component",
					props: props.filter((prop) =>
						(supported[name] ?? []).includes(prop ?? ""),
					),
				});
			}
		}
	});

	it("has no import or export statements", async () => {
		// MDX reads ESM only at the start of a block; a paragraph line that happens to begin with
		// "export" (observability.mdx has one) is prose.
		for (const page of (await exported()).pages) {
			expect({
				file: page.file,
				statements:
					`\n\n${markup(page.mdx)}`.match(/\n\n(?:import|export)\s/gu) ?? [],
			}).toEqual({ file: page.file, statements: [] });
		}
	});

	it("names a language on every code block", async () => {
		for (const page of (await exported()).pages) {
			const unlabelled = [...page.mdx.matchAll(fence)].filter((block) =>
				/^[ \t]*```[ \t]*\n/u.test(block[0]),
			);
			expect({ file: page.file, unlabelled: unlabelled.length }).toEqual({
				file: page.file,
				unlabelled: 0,
			});
		}
	});
});
