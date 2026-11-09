import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, type Column } from "./datatable";
import assert from "node:assert/strict";
import { test } from "node:test";

const rows = Array.from({ length: 12 }, (_, index) => ({
	id: String(index),
	name: `Row ${index}`,
}));
const columns: Column<(typeof rows)[number]>[] = [
	{ key: "name", header: "Name", render: (row) => row.name },
];

test("existing tables render the full collection without client pagination", () => {
	const html = renderToStaticMarkup(
		<DataTable
			caption="Models"
			columns={columns}
			rowKey={(row) => row.id}
			rows={rows}
		/>,
	);
	assert.match(html, /<caption[^>]*>Models<\/caption>/u);
	assert.match(html, />Row 11</u);
	assert.doesNotMatch(html, /Next page/u);
});

test("client pagination limits rows and keeps inaccessible pages disabled", () => {
	const html = renderToStaticMarkup(
		<DataTable
			columns={columns}
			pagination={{ pageSize: 5 }}
			rowKey={(row) => row.id}
			rows={rows}
		/>,
	);
	assert.match(html, />Row 4</u);
	assert.doesNotMatch(html, />Row 5</u);
	assert.match(html, /1–5 of 12 results/u);
	assert.match(html, /<button[^>]*aria-label="Previous page"[^>]*disabled/u);
});

test("empty and loading tables retain semantic status feedback", () => {
	for (const loading of [false, true]) {
		const html = renderToStaticMarkup(
			<DataTable
				columns={columns}
				loading={loading}
				pagination={{}}
				rowKey={(row) => row.id}
				rows={[]}
			/>,
		);
		if (loading) {
			assert.match(html, /aria-busy="true"/u);
			assert.equal(html.match(/<tr[^>]*aria-hidden="true"/gu)?.length, 8);
			assert.match(html, /data-slot="skeleton"/u);
		} else {
			assert.match(html, /No results found\./u);
		}
		assert.match(html, /0–0 of 0 results/u);
		assert.match(html, /<button[^>]*aria-label="Next page"[^>]*disabled/u);
	}
});

test("invalid page sizes fall back and numeric custom radii retain CSS units", () => {
	const html = renderToStaticMarkup(
		<DataTable
			borderRadius={8}
			columns={columns}
			pagination={{ pageSize: 0 }}
			rowKey={(row) => row.id}
			rows={rows}
		/>,
	);
	assert.match(html, /1–10 of 12 results/u);
	assert.match(html, /--table-radius:8px/u);
});
