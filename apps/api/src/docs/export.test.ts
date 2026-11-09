import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { buildDocsExport, readDocsContent } from "./export.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * `/docs/export.json` is read by boelabs.com, which compiles the MDX with its own closed set of
 * components. A field that changes shape, a draft that leaks, or a component it does not have
 * breaks a site in another repository, so all three are checked here rather than discovered there.
 */
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
const heading = /^#{1,6} +(.+?)\s*$/gmu;
const customId = /\s*\[#([^\]]+)\]$/u;

/** The MDX a reader sees as markup: code blocks and inline code removed. */
function markup(mdx: string): string {
	return mdx.replace(fence, "").replace(inlineCode, "");
}

/** Heading anchors as Fumadocs builds them: a `[#id]` suffix, or the GitHub slug of the text. */
function anchors(mdx: string): Set<string> {
	const ids = new Set<string>();
	const seen = new Map<string, number>();
	for (const [, text = ""] of mdx.replace(fence, "").matchAll(heading)) {
		const custom = customId.exec(text);
		if (custom?.[1]) {
			ids.add(custom[1]);
			continue;
		}
		const base = text
			.replace(/`([^`]*)`/gu, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\s_-]/gu, "")
			.replace(/\s/gu, "-");
		const count = seen.get(base) ?? 0;
		seen.set(base, count + 1);
		ids.add(count === 0 ? base : `${base}-${count}`);
	}
	return ids;
}

const exported = buildDocsExport(await readDocsContent(), new Date());

describe("docs export", () => {
	it("matches the shared contract", () => {
		const result = contract.safeParse(exported);
		assert.deepEqual(result.success ? [] : result.error.issues, []);
	});

	it("exports every page and folder in both languages", () => {
		const { pages, meta } = exported;
		const en = pages.filter((page) => page.locale === "en");
		const es = pages.filter((page) => page.locale === "es");
		assert.ok(en.length > 0);
		assert.deepEqual(
			es.map((page) => page.path).sort(),
			en.map((page) => page.path).sort(),
		);
		assert.equal(new Set(en.map((page) => page.path)).size, en.length);
		assert.deepEqual(
			meta.filter((entry) => entry.locale === "es").map((entry) => entry.dir),
			meta.filter((entry) => entry.locale === "en").map((entry) => entry.dir),
		);
	});

	it("gives every English page its public path", () => {
		for (const page of exported.pages) {
			if (page.locale !== "en") {
				continue;
			}
			const kept = page.file
				.replace(/\.mdx$/u, "")
				.split("/")
				.filter((part) => !/^\(.+\)$/u.test(part));
			const expected = kept.at(-1) === "index" ? kept.slice(0, -1) : kept;
			assert.deepEqual(
				{ file: page.file, path: page.path },
				{
					file: page.file,
					path: expected.join("/"),
				},
			);
		}
		const paths = exported.pages.map((page) => page.path);
		for (const path of ["", "quickstart", "api-overview", "providers-openai"]) {
			assert.ok(paths.includes(path), path);
		}
	});

	it("ships the MDX body without frontmatter, linking to /docs pages and headings that exist", () => {
		const targets = new Map(
			exported.pages
				.filter((page) => page.locale === "en")
				.map((page) => [page.path, anchors(page.mdx)]),
		);
		for (const page of exported.pages) {
			assert.ok(!page.mdx.startsWith("---"), page.file);
			const own = anchors(page.mdx);
			for (const match of page.mdx.matchAll(
				/\]\(([/#][^\s)]*)\)|href="([/#][^"]*)"/gu,
			)) {
				const link = match[1] ?? match[2] ?? "";
				const [target = "", fragment] = link.split("#");
				const path = target.replace(/^\/docs\/?/u, "").replace(/\?.*$/u, "");
				const ids = target ? targets.get(path) : own;
				assert.deepEqual(
					{
						file: page.file,
						link,
						internal: target === "" || target.startsWith("/docs"),
						page: ids !== undefined,
						heading: fragment === undefined || (ids?.has(fragment) ?? false),
					},
					{
						file: page.file,
						link,
						internal: true,
						page: true,
						heading: true,
					},
				);
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
			assert.deepEqual(
				pages.map((page) => page.path),
				["published"],
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
		for (const page of exported.pages) {
			assert.equal(page.frontmatter.draft, undefined);
		}
	});
});

describe("published MDX", () => {
	it("uses only the components boelabs.com supports, with their props", () => {
		for (const page of exported.pages) {
			for (const [, name = "", attributes = ""] of markup(page.mdx).matchAll(
				element,
			)) {
				const props = [...attributes.matchAll(attribute)].map((m) => m[1]);
				assert.deepEqual(
					{ file: page.file, name, props },
					{
						file: page.file,
						name: name in supported ? name : "a supported component",
						props: props.filter((prop) =>
							(supported[name] ?? []).includes(prop ?? ""),
						),
					},
				);
			}
		}
	});

	it("has no import or export statements", () => {
		// MDX reads ESM only at the start of a block; a paragraph line that happens to begin with
		// "export" (observability.mdx has one) is prose.
		for (const page of exported.pages) {
			assert.deepEqual(
				{
					file: page.file,
					statements:
						`\n\n${markup(page.mdx)}`.match(/\n\n(?:import|export)\s/gu) ?? [],
				},
				{ file: page.file, statements: [] },
			);
		}
	});

	it("names a language on every code block", () => {
		for (const page of exported.pages) {
			const unlabelled = [...page.mdx.matchAll(fence)].filter((block) =>
				/^[ \t]*```[ \t]*\n/u.test(block[0]),
			);
			assert.deepEqual(
				{ file: page.file, unlabelled: unlabelled.length },
				{
					file: page.file,
					unlabelled: 0,
				},
			);
		}
	});
});
