/**
 * The bytes one request may download, shared by its remote inputs. Each fetch reserves what it may
 * read before it starts and is capped to that, so concurrent downloads cannot together pass the
 * limit before any of them is counted. A fetch that does not fit waits for another to settle and
 * return what it did not use; only when nothing is in flight does it get the true remainder, and a
 * request with none left is refused.
 */
export class ByteBudget {
	#remaining: number;
	#inFlight = 0;
	readonly #waiters: Array<() => void> = [];
	readonly #exhausted: (param: string) => Error;

	constructor(limit: number, exhausted: (param: string) => Error) {
		this.#remaining = limit;
		this.#exhausted = exhausted;
	}

	async run<T extends { bytes: Uint8Array }>(
		maxBytes: number,
		param: string,
		fetch: (grant: number) => Promise<T>,
	): Promise<T> {
		while (this.#remaining < maxBytes && this.#inFlight > 0) {
			await new Promise<void>((resolve) => this.#waiters.push(resolve));
		}
		const grant = Math.min(maxBytes, this.#remaining);
		if (grant <= 0) {
			throw this.#exhausted(param);
		}
		this.#remaining -= grant;
		this.#inFlight += 1;
		let used = 0;
		try {
			const result = await fetch(grant);
			used = result.bytes.byteLength;
			return result;
		} finally {
			this.#remaining += grant - used;
			this.#inFlight -= 1;
			for (const wake of this.#waiters.splice(0)) {
				wake();
			}
		}
	}
}
