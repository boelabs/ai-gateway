import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	type PdfTextJob,
	type PdfWorker,
	PdfWorkerPool,
} from "./pdfWorkerPool.ts";

function ignore(): void {
	/* intentionally empty */
}

class FakeWorker extends EventEmitter {
	readonly jobs: Array<{ id: number }> = [];
	terminated = false;

	postMessage = (message: { id: number }) => {
		this.jobs.push(message);
	};

	terminate = () => {
		this.terminated = true;
		return Promise.resolve(0);
	};

	readonly unref = ignore;

	reply(text: string): void {
		const job = this.jobs.shift();
		assert.ok(job);
		this.emit("message", { id: job.id, ok: true, text, totalPages: 1 });
	}
}

function fakeWorkers() {
	const created: FakeWorker[] = [];
	const createWorker = () => {
		const worker = new FakeWorker();
		created.push(worker);
		return worker as unknown as PdfWorker;
	};
	return { created, createWorker };
}

const CLIENT_LEFT = /client left/u;

const JOB: PdfTextJob = {
	bytes: new Uint8Array([1, 2, 3]),
	maxCharacters: 100,
	maxPages: 10,
};

test("pool never runs more workers than its size and reuses them", async () => {
	const { created, createWorker } = fakeWorkers();
	const pool = new PdfWorkerPool({
		size: 2,
		maxQueued: 10,
		jobTimeoutMs: 1000,
		createWorker,
	});
	const { signal } = new AbortController();
	const results = Array.from({ length: 5 }, () => pool.run(JOB, signal));
	assert.equal(created.length, 2);
	assert.equal(pool.queued, 3);
	for (let round = 0; round < 3; round += 1) {
		for (const worker of created) {
			if (worker.jobs.length > 0) {
				worker.reply("text");
			}
		}
	}
	const settled = await Promise.all(results);
	assert.equal(settled.length, 5);
	assert.ok(settled.every((result) => result.ok));
	assert.equal(created.length, 2);
	await pool.close();
});

test("a job over its time budget fails and its worker is replaced", async () => {
	const { created, createWorker } = fakeWorkers();
	const pool = new PdfWorkerPool({
		size: 1,
		maxQueued: 10,
		jobTimeoutMs: 10,
		createWorker,
	});
	const { signal } = new AbortController();
	const result = await pool.run(JOB, signal);
	assert.equal(result.ok, false);
	const [first] = created;
	assert.equal(first?.terminated, true);
	const next = pool.run(JOB, signal);
	assert.equal(created.length, 2);
	const [, replacement] = created;
	replacement?.reply("ok");
	assert.equal((await next).ok, true);
	await pool.close();
});

test("aborting a running job terminates its worker; aborting a queued one dequeues it", async () => {
	const { created, createWorker } = fakeWorkers();
	const pool = new PdfWorkerPool({
		size: 1,
		maxQueued: 10,
		jobTimeoutMs: 1000,
		createWorker,
	});
	const running = new AbortController();
	const waiting = new AbortController();
	const first = pool.run(JOB, running.signal);
	const second = pool.run(JOB, waiting.signal);
	waiting.abort(new Error("client left"));
	await assert.rejects(second, CLIENT_LEFT);
	assert.equal(pool.queued, 0);
	running.abort(new Error("client left"));
	await assert.rejects(first, CLIENT_LEFT);
	const [worker] = created;
	assert.equal(worker?.terminated, true);
	assert.equal(pool.liveWorkers, 0);
	await pool.close();
});

test("a full queue rejects with a retryable error", async () => {
	const { createWorker } = fakeWorkers();
	const pool = new PdfWorkerPool({
		size: 1,
		maxQueued: 1,
		jobTimeoutMs: 1000,
		createWorker,
	});
	const { signal } = new AbortController();
	const pending = [pool.run(JOB, signal), pool.run(JOB, signal)];
	await assert.rejects(pool.run(JOB, signal), (error: unknown) => {
		assert.equal((error as { code?: string }).code, "file_parser_busy");
		return true;
	});
	await pool.close();
	await Promise.allSettled(pending);
});
