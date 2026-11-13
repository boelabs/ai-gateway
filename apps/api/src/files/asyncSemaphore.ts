/** At most `limit` operations run at once; the rest wait in arrival order. */
export class AsyncSemaphore {
	#available: number;
	readonly #waiters: Array<() => void> = [];

	constructor(limit: number) {
		this.#available = limit;
	}

	async run<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#available === 0) {
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		} else {
			this.#available -= 1;
		}
		try {
			return await operation();
		} finally {
			const next = this.#waiters.shift();
			if (next) {
				next();
			} else {
				this.#available += 1;
			}
		}
	}
}
