/**
 * Process-wide pool of PDF text-extraction workers.
 *
 * Parsing runs off the event loop, but a worker costs tens of megabytes, so the process keeps a
 * small fixed number of long-lived workers and queues jobs for them instead of starting one per
 * file. Each job has a time budget; a job that exceeds it, or whose request is aborted while it
 * runs, terminates its worker, which is replaced on the next dispatch.
 */

import { GatewayError } from "#core/errors.ts";
import { Worker } from "node:worker_threads";

export interface PdfTextJob {
	bytes: Uint8Array;
	maxCharacters: number;
	maxPages: number;
}

export type PdfTextResult =
	| { ok: true; text: string; totalPages: number }
	| {
			ok: false;
			code: "too_many_characters" | "too_many_pages" | "parse_failed";
			message: string;
	  };

type WorkerReply = PdfTextResult & { id: number };

/** The part of `Worker` the pool uses, so tests can supply a fake. */
export type PdfWorker = Pick<
	Worker,
	"postMessage" | "on" | "terminate" | "unref"
>;

export interface PdfWorkerPoolOptions {
	size: number;
	maxQueued: number;
	jobTimeoutMs: number;
	createWorker: () => PdfWorker;
}

interface QueuedJob {
	id: number;
	job: PdfTextJob;
	signal: AbortSignal;
	resolve: (result: PdfTextResult) => void;
	reject: (error: unknown) => void;
	onAbort: () => void;
}

interface Slot {
	worker: PdfWorker | null;
	running: QueuedJob | null;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export class PdfWorkerPool {
	readonly #options: PdfWorkerPoolOptions;
	readonly #slots: Slot[];
	readonly #queue: QueuedJob[] = [];
	#nextId = 1;

	constructor(options: PdfWorkerPoolOptions) {
		this.#options = options;
		this.#slots = Array.from({ length: options.size }, () => ({
			worker: null,
			running: null,
			timer: undefined,
		}));
	}

	/** Workers currently alive (for tests and diagnostics). */
	get liveWorkers(): number {
		return this.#slots.filter((slot) => slot.worker !== null).length;
	}

	get queued(): number {
		return this.#queue.length;
	}

	run(job: PdfTextJob, signal: AbortSignal): Promise<PdfTextResult> {
		signal.throwIfAborted();
		if (this.#queue.length >= this.#options.maxQueued) {
			return Promise.reject(
				new GatewayError({
					class: "rate_limit",
					code: "file_parser_busy",
					param: "messages",
					message: `PDF parser queue is full (${this.#options.maxQueued} jobs waiting)`,
					publicMessage: "The file parser is busy. Retry the request shortly.",
					deploymentHealth: "neutral",
				}),
			);
		}
		return new Promise<PdfTextResult>((resolve, reject) => {
			const queued: QueuedJob = {
				id: this.#nextId++,
				job,
				signal,
				resolve,
				reject,
				onAbort: () => this.#abort(queued),
			};
			signal.addEventListener("abort", queued.onAbort, { once: true });
			this.#queue.push(queued);
			this.#dispatch();
		});
	}

	/** Terminates every worker and fails pending jobs. */
	async close(): Promise<void> {
		const error = new Error("PDF worker pool closed");
		for (const queued of this.#queue.splice(0)) {
			settle(queued, () => queued.reject(error));
		}
		await Promise.all(
			this.#slots.map(async (slot) => {
				const { running } = slot;
				if (running) {
					settle(running, () => running.reject(error));
				}
				await retire(slot);
			}),
		);
	}

	#dispatch(): void {
		for (const slot of this.#slots) {
			if (slot.running !== null) {
				continue;
			}
			const next = this.#queue.shift();
			if (next === undefined) {
				return;
			}
			this.#start(slot, next);
		}
	}

	#start(slot: Slot, queued: QueuedJob): void {
		const worker = slot.worker ?? this.#spawn(slot);
		slot.running = queued;
		slot.timer = setTimeout(() => {
			this.#fail(slot, {
				ok: false,
				code: "parse_failed",
				message: `PDF parsing exceeded its ${this.#options.jobTimeoutMs} ms budget`,
			});
		}, this.#options.jobTimeoutMs);
		const transferred = queued.job.bytes.slice().buffer;
		worker.postMessage(
			{
				id: queued.id,
				bytes: transferred,
				maxCharacters: queued.job.maxCharacters,
				maxPages: queued.job.maxPages,
			},
			[transferred],
		);
	}

	#spawn(slot: Slot): PdfWorker {
		const worker = this.#options.createWorker();
		worker.unref();
		worker.on("message", (reply: WorkerReply) => {
			const { running } = slot;
			if (slot.worker !== worker || running?.id !== reply.id) {
				return;
			}
			const { id: _id, ...result } = reply;
			release(slot);
			settle(running, () => running.resolve(result as PdfTextResult));
			this.#dispatch();
		});
		worker.on("error", (error: Error) => {
			if (slot.worker === worker) {
				this.#fail(slot, {
					ok: false,
					code: "parse_failed",
					message: error.message,
				});
			}
		});
		worker.on("exit", (code: number) => {
			if (slot.worker === worker) {
				this.#fail(slot, {
					ok: false,
					code: "parse_failed",
					message: `PDF parser worker exited before replying (code ${code})`,
				});
			}
		});
		slot.worker = worker;
		return worker;
	}

	/** The running job ends with `result` and its worker is discarded. */
	#fail(slot: Slot, result: PdfTextResult): void {
		const { running } = slot;
		release(slot);
		void retire(slot);
		if (running) {
			settle(running, () => running.resolve(result));
		}
		this.#dispatch();
	}

	#abort(queued: QueuedJob): void {
		const index = this.#queue.indexOf(queued);
		if (index !== -1) {
			this.#queue.splice(index, 1);
			settle(queued, () => queued.reject(queued.signal.reason));
			return;
		}
		const slot = this.#slots.find((candidate) => candidate.running === queued);
		if (slot) {
			release(slot);
			void retire(slot);
			settle(queued, () => queued.reject(queued.signal.reason));
			this.#dispatch();
		}
	}
}

function release(slot: Slot): void {
	clearTimeout(slot.timer);
	slot.timer = undefined;
	slot.running = null;
}

async function retire(slot: Slot): Promise<void> {
	const { worker } = slot;
	slot.worker = null;
	await worker?.terminate();
}

function settle(queued: QueuedJob, finish: () => void): void {
	queued.signal.removeEventListener("abort", queued.onAbort);
	finish();
}

const POOL_SIZE = 2;
const MAX_QUEUED_JOBS = 64;
const JOB_TIMEOUT_MS = 30_000;

let shared: PdfWorkerPool | undefined;

/** The process-wide pool, created on first use. */
export function pdfWorkerPool(): PdfWorkerPool {
	shared ??= new PdfWorkerPool({
		size: POOL_SIZE,
		maxQueued: MAX_QUEUED_JOBS,
		jobTimeoutMs: JOB_TIMEOUT_MS,
		createWorker: () =>
			new Worker(new URL("./pdfTextWorker.ts", import.meta.url), {
				// Honoured where the runtime supports per-worker heap limits.
				resourceLimits: { maxOldGenerationSizeMb: 256 },
			}),
	});
	return shared;
}
