import { expect, test } from "bun:test";
import {
	base64LiftedSink,
	liftedIndex,
	liftedPlaceholder,
	parseJsonLifting,
} from "./liftedJson.ts";

/** A body delivered in pieces of `size` bytes, so tokens and escapes straddle chunk boundaries. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close();
				return;
			}
			controller.enqueue(bytes.slice(offset, offset + size));
			offset += size;
		},
	});
}

function collecting() {
	const strings: string[] = [];
	const ended: number[] = [];
	return {
		strings,
		ended,
		chunk(index: number, text: string) {
			strings[index] = (strings[index] ?? "") + text;
		},
		end(index: number) {
			ended.push(index);
		},
	};
}

test("short strings parse as JSON.parse would, at any chunk boundary", async () => {
	const doc = {
		id: "abc",
		status: "completed",
		escapes: 'quote " backslash \\ slash / tab \t newline \n é ✓ \u0001',
		nested: [{ n: 1.5, ok: true, none: null }, []],
	};
	const text = JSON.stringify(doc);
	for (const size of [1, 2, 3, 7, 64, text.length]) {
		expect(
			await parseJsonLifting(chunked(text, size), undefined, 1000),
		).toEqual(doc);
	}
});

test("long strings are streamed to the sink and replaced by a placeholder", async () => {
	const long = `${"A".repeat(40)}\\"/\né${"B".repeat(40)}`;
	const other = "C".repeat(60);
	const text = JSON.stringify({
		status: "completed",
		steps: [{ content: [{ type: "video", data: long }] }],
		tail: { other, short: "kept" },
	});
	for (const size of [1, 3, 5, 16, text.length]) {
		const sink = collecting();
		const parsed = (await parseJsonLifting(chunked(text, size), sink, 32)) as {
			steps: { content: { data: string }[] }[];
			tail: { other: string; short: string };
			status: string;
		};
		expect(parsed.status).toBe("completed");
		expect(parsed.tail.short).toBe("kept");
		expect(parsed.steps[0]?.content[0]?.data).toBe(liftedPlaceholder(0));
		expect(liftedIndex(parsed.tail.other)).toBe(1);
		expect(sink.strings).toEqual([long, other]);
		expect(sink.ended).toEqual([0, 1]);
	}
});

test("a string at the threshold stays in the document", async () => {
	const value = "x".repeat(32);
	expect(
		await parseJsonLifting(
			chunked(JSON.stringify({ value }), 4),
			undefined,
			32,
		),
	).toEqual({ value });
});

test("the base64 sink decodes lifted video bytes across chunk boundaries", async () => {
	const video = new Uint8Array(5000).map((_, i) => (i * 37 + 11) % 256);
	const data = Buffer.from(video).toString("base64");
	const text = JSON.stringify({ content: [{ type: "video", data }] });
	for (const size of [1, 7, 333, text.length]) {
		const sink = base64LiftedSink();
		const parsed = (await parseJsonLifting(chunked(text, size), sink, 100)) as {
			content: { data: string }[];
		};
		const index = liftedIndex(parsed.content[0]?.data);
		expect(index).toBe(0);
		const chunks = sink.bytes(index ?? -1) ?? [];
		expect(Buffer.concat(chunks).equals(Buffer.from(video))).toBe(true);
	}
});

test("a body that is not JSON is rejected", async () => {
	await expect(parseJsonLifting(chunked("<html>", 2))).rejects.toThrow(
		SyntaxError,
	);
	await expect(
		parseJsonLifting(chunked('{"a":"\\u00', 3), undefined, 1000),
	).rejects.toThrow(SyntaxError);
});

test("placeholders are recognised only for lifted strings", () => {
	expect(liftedIndex(liftedPlaceholder(3))).toBe(3);
	expect(liftedIndex("lifted:3")).toBeUndefined();
	expect(liftedIndex(42)).toBeUndefined();
});
