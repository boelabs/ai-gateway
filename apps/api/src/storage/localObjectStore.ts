import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { GatewayError } from "#core/errors.ts";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
	type PutObjectInput,
	rangeNotSatisfiable,
	type StoredObject,
	contentTypeForKey,
	type ObjectRange,
	type ObjectStore,
	toNodeReadable,
	missingObject,
	assertSafeKey,
	resolveRange,
} from "./objects.ts";

export class LocalObjectStore implements ObjectStore {
	readonly backend = "local" as const;
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	private pathFor(key: string): string {
		assertSafeKey(key);
		const path = resolve(this.root, key);
		if (!path.startsWith(this.root)) {
			throw new GatewayError({
				class: "server",
				message: `Object key escapes storage root: ${key}`,
			});
		}
		return path;
	}

	/**
	 * Writes to a temporary file beside the target and renames it into place, so a reader never sees
	 * a half-written object and a failed upload leaves nothing at the key.
	 */
	async put(input: PutObjectInput): Promise<{ etag?: string }> {
		const path = this.pathFor(input.key);
		await mkdir(dirname(path), { recursive: true });
		const partial = `${path}.${randomUUID()}.partial`;
		try {
			await pipeline(toNodeReadable(input.body), createWriteStream(partial));
			await rename(partial, path);
		} catch (error) {
			await unlink(partial).catch(() => undefined);
			throw error;
		}
		return {};
	}

	async get(key: string, range?: ObjectRange): Promise<StoredObject> {
		const path = this.pathFor(key);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(path);
		} catch (cause) {
			throw missingObject(key, cause);
		}
		if (info.size === 0) {
			if (range) {
				throw rangeNotSatisfiable();
			}
			return {
				body: Readable.toWeb(Readable.from([])) as ReadableStream<Uint8Array>,
				contentType: contentTypeForKey(key),
				contentLength: 0,
			};
		}
		const { start, end } = range
			? resolveRange(range, info.size)
			: { start: 0, end: info.size - 1 };
		return {
			body: Readable.toWeb(
				createReadStream(path, { start, end }),
			) as ReadableStream<Uint8Array>,
			contentType: contentTypeForKey(key),
			contentLength: end - start + 1,
			...(range ? { range: { start, end, total: info.size } } : {}),
		};
	}

	async head(key: string): Promise<Omit<StoredObject, "body">> {
		const path = this.pathFor(key);
		try {
			const info = await stat(path);
			return {
				contentType: contentTypeForKey(key),
				contentLength: info.size,
			};
		} catch (cause) {
			throw missingObject(key, cause);
		}
	}

	async delete(key: string): Promise<void> {
		const path = this.pathFor(key);
		await unlink(path).catch((err: { code?: string }) => {
			if (err.code !== "ENOENT") {
				throw err;
			}
		});
	}
}
