import type { ObjectStorageConfig } from "./config.ts";

import {
	type PutObjectInput,
	rangeNotSatisfiable,
	type StoredObject,
	contentTypeForKey,
	type ObjectRange,
	type ObjectStore,
	missingObject,
	assertSafeKey,
	resolveRange,
} from "./objects.ts";

/** Bun reports S3 failures as errors whose `code` is the S3 error code (`NoSuchKey`, ...). */
function isMissing(err: unknown): boolean {
	const { code } = err as { code?: string };
	return (
		code === "NoSuchKey" ||
		code === "NotFound" ||
		code === "ERR_S3_FILE_NOT_FOUND"
	);
}

/**
 * S3 (or anything that speaks it: R2, MinIO) through Bun's native client. Bun streams a body of
 * unknown length as a multipart upload, which providers' chunked video downloads need.
 */
export class S3ObjectStore implements ObjectStore {
	readonly backend = "s3" as const;
	private readonly client: Bun.S3Client;

	constructor(config: Extract<ObjectStorageConfig, { backend: "s3" }>) {
		this.client = new Bun.S3Client({
			bucket: config.bucket,
			region: config.region,
			...(config.endpoint ? { endpoint: config.endpoint } : {}),
			virtualHostedStyle: !config.forcePathStyle,
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		});
	}

	private file(key: string): Bun.S3File {
		assertSafeKey(key);
		return this.client.file(key);
	}

	private async stat(key: string) {
		return await this.file(key)
			.stat()
			.catch((err: unknown) => {
				throw isMissing(err) ? missingObject(key, err) : err;
			});
	}

	async put(input: PutObjectInput): Promise<{ etag?: string }> {
		const file = this.file(input.key);
		await file.write(new Response(input.body), { type: input.contentType });
		// Bun's write reports bytes, not the ETag the video rows keep; one HEAD recovers it.
		const { etag } = await this.stat(input.key);
		return etag ? { etag } : {};
	}

	async get(key: string, range?: ObjectRange): Promise<StoredObject> {
		const stat = await this.stat(key);
		const contentType = stat.type || contentTypeForKey(key);
		const etag = stat.etag ? { etag: stat.etag } : {};
		const file = this.file(key);
		if (!range) {
			return {
				body: file.stream(),
				contentType,
				contentLength: stat.size,
				...etag,
			};
		}
		if (stat.size === 0) {
			throw rangeNotSatisfiable();
		}
		const { start, end } = resolveRange(range, stat.size);
		return {
			body: file.slice(start, end + 1).stream(),
			contentType,
			contentLength: end - start + 1,
			...etag,
			range: { start, end, total: stat.size },
		};
	}

	async head(key: string): Promise<Omit<StoredObject, "body">> {
		const stat = await this.stat(key);
		return {
			contentType: stat.type || contentTypeForKey(key),
			contentLength: stat.size,
			...(stat.etag ? { etag: stat.etag } : {}),
		};
	}

	async delete(key: string): Promise<void> {
		await this.file(key).delete();
	}
}
