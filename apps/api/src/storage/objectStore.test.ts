import { LocalObjectStore } from "./localObjectStore.ts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("a failed local put leaves nothing at the key", async () => {
	const root = await mkdtemp(join(tmpdir(), "ai-gateway-store-"));
	try {
		const store = new LocalObjectStore(root);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1, 2, 3]));
				controller.error(new Error("provider stream cut"));
			},
		});
		await assert.rejects(
			store.put({ key: "videos/a.mp4", body, contentType: "video/mp4" }),
		);
		assert.deepEqual(await readdir(join(root, "videos")), []);
		await store.put({
			key: "videos/a.mp4",
			body: new Blob([new Uint8Array([4, 5])]).stream(),
			contentType: "video/mp4",
		});
		assert.deepEqual(await readdir(join(root, "videos")), ["a.mp4"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
