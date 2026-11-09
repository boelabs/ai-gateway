import { readdir, readFile } from "node:fs/promises";
import { DOCS_ROOT as root } from "./export.ts";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The navigation, the pages on disk and the two languages cannot drift apart.
 *
 * Every failure here is silent in production: a page missing from its folder's `meta.json` is still
 * exported but invisible in boelabs.com's sidebar, a page that changes path breaks every saved link,
 * and a translation that loses an example or a link reads fine until someone follows it.
 */
const files = (await readdir(root, { recursive: true }))
	.map((entry) => entry.replaceAll("\\", "/"))
	.sort();

const groupFolder = /^\(.+\)$/u;

async function text(file: string): Promise<string> {
	return (await readFile(join(root, file), "utf8")).replaceAll("\r\n", "\n");
}

async function meta(dir: string, name = "meta.json") {
	return JSON.parse(await text(dir ? `${dir}/${name}` : name)) as {
		pages?: string[];
		root?: boolean;
		icon?: string;
	};
}

/** Directory of a path relative to `docs/`; `""` is `docs/` itself. */
function dirOf(file: string): string {
	return file.split("/").slice(0, -1).join("/");
}

/** Files directly inside `dir`, not in a subfolder. */
function childrenOf(dir: string): string[] {
	return files.filter((file) => dirOf(file) === dir);
}

const folders = files
	.filter((file) => file.endsWith("/meta.json") || file === "meta.json")
	.map(dirOf);
const englishPages = files.filter(
	(file) => file.endsWith(".mdx") && !file.endsWith(".es.mdx"),
);

describe("navigation", () => {
	it("lists exactly the pages and folders that exist beside it", async () => {
		for (const dir of folders) {
			const listed = ((await meta(dir)).pages ?? [])
				.filter((item) => !item.startsWith("---"))
				.map((item) => item.replace(/^\.\.\./u, ""))
				.sort();
			const present = [
				...childrenOf(dir)
					.filter((file) => file.endsWith(".mdx") && !file.endsWith(".es.mdx"))
					.map((file) => (file.split("/").at(-1) ?? "").replace(/\.mdx$/u, "")),
				// A nested group is listed by its folder name, parentheses included.
				...folders
					.filter((folder) => folder !== dir && dirOf(folder) === dir)
					.map((folder) => folder.split("/").at(-1) ?? ""),
			].sort();
			assert.deepEqual({ dir, listed }, { dir, listed: present });
		}
	});

	it("has exactly two switcher roots, each with a page of its own", async () => {
		const roots: string[] = [];
		for (const dir of folders) {
			if ((await meta(dir)).root) {
				roots.push(dir);
			}
		}
		assert.deepEqual(roots, ["(api)", "(docs)"]);
		for (const file of files.filter((entry) => entry.endsWith(".mdx"))) {
			assert.ok(file.startsWith("("), `${file} is outside a switcher root`);
		}
		// The switcher links a root to its first direct page; a root holding only folders has none.
		for (const dir of roots) {
			assert.ok(
				childrenOf(dir).some((file) => file.endsWith(".mdx")),
				`${dir} has no page of its own`,
			);
		}
	});

	it("keeps every page at the address it has always had", () => {
		// A `(group)` folder is stripped from the path, which is what lets pages be regrouped without
		// moving a single URL. A nested address would mean a group folder lost its parentheses.
		const paths = new Set(
			englishPages.map((file) => {
				const parts = file.replace(/\.mdx$/u, "").split("/");
				const kept = parts.filter((part) => !groupFolder.test(part));
				return kept.at(-1) === "index" ? "" : kept.join("/");
			}),
		);
		for (const path of [
			"",
			"quickstart",
			"api-overview",
			"deployment",
			"dashboard",
			"reference-environment",
			"providers-openai",
		]) {
			assert.ok(paths.has(path), `missing /docs/${path}`);
		}
		for (const path of paths) {
			assert.ok(!path.includes("/"), `/docs/${path} is nested`);
		}
	});
});

const fences = /^```[^\n]*\n([\s\S]*?)^```/gmu;
const inlineCode = /`[^`]+`/gu;
const codeWhitespace = /\s+/gu;
const section = /^#{2,6} /gmu;
const links = /\]\(([^\s)]+)\)|href="([^"]+)"/gu;

function codeBlocks(source: string): string[] {
	return [...source.matchAll(fences)].map((match) => match[1] ?? "");
}

function inline(prose: string): string[] {
	return [...prose.matchAll(inlineCode)]
		.map((match) => match[0].replace(codeWhitespace, " "))
		.sort();
}

function targets(prose: string): string[] {
	return [...prose.matchAll(links)]
		.map((match) => match[1] ?? match[2] ?? "")
		.sort();
}

describe("translation", () => {
	it("pairs every page and preserves examples, inline code, links, and heading anchors", async () => {
		for (const file of files.filter((entry) => entry.endsWith(".es.mdx"))) {
			assert.ok(
				existsSync(join(root, file.replace(/\.es\.mdx$/u, ".mdx"))),
				`${file} has no English page`,
			);
		}
		for (const file of englishPages) {
			const translation = file.replace(/\.mdx$/u, ".es.mdx");
			assert.ok(files.includes(translation), `${file} has no translation`);
			const english = await text(file);
			const spanish = await text(translation);
			assert.deepEqual(
				{ file, examples: codeBlocks(spanish) },
				{ file, examples: codeBlocks(english) },
			);
			const enProse = english.replace(fences, "");
			const esProse = spanish.replace(fences, "");
			assert.deepEqual(
				{ file, code: inline(esProse) },
				{ file, code: inline(enProse) },
			);
			// A translated heading keeps the English anchor through a `[#id]` suffix.
			assert.equal(
				[...esProse.matchAll(/\[#([^\]]+)\]\s*$/gmu)].length,
				[...enProse.matchAll(section)].length,
				`${file}: a Spanish heading lost its [#id]`,
			);
			// Both languages link to `/docs/<path>`; boelabs.com localizes the address.
			assert.deepEqual(
				{ file, links: targets(esProse) },
				{ file, links: targets(enProse) },
			);
		}
	});

	it("keeps the same pages and groups in both navigation trees", async () => {
		const entries = (pages: string[] = []) =>
			pages.map((page) => (page.startsWith("---") ? "---" : page));
		for (const dir of folders) {
			const english = await meta(dir);
			const spanish = await meta(dir, "meta.es.json");
			assert.deepEqual(
				{ dir, pages: entries(spanish.pages) },
				{ dir, pages: entries(english.pages) },
			);
			assert.equal(spanish.root, english.root);
			assert.equal(spanish.icon, english.icon);
		}
	});
});
