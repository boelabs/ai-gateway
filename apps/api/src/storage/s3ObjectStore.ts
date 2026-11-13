import type { ObjectStorageConfig } from "./config.ts";
import { Upload } from "@aws-sdk/lib-storage";
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
} from "./objects.ts";

import {
	DeleteObjectCommand,
	HeadObjectCommand,
	GetObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

function toHttpRange(range: ObjectRange): string {
	if ("suffix" in range) {
		return `bytes=-${range.suffix}`;
	}
	return range.end === undefined
		? `bytes=${range.start}-`
		: `bytes=${range.start}-${range.end}`;
}

function toWebReadable(body: unknown): ReadableStream<Uint8Array> {
	if (body instanceof ReadableStream) {
		return body;
	}
	if (body instanceof Uint8Array) {
		return Readable.toWeb(Readable.from(body));
	}
	if (
		body &&
		typeof (body as { transformToWebStream?: unknown }).transformToWebStream ===
			"function"
	) {
		return (
			body as { transformToWebStream: () => ReadableStream<Uint8Array> }
		).transformToWebStream();
	}
	return Readable.toWeb(body as Readable) as ReadableStream<Uint8Array>;
}

function parseContentRange(
	value: string | undefined,
): StoredObject["range"] | undefined {
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value ?? "");
	if (!match) {
		return undefined;
	}
	return {
		start: Number(match[1]),
		end: Number(match[2]),
		total: Number(match[3]),
	};
}

export class S3ObjectStore implements ObjectStore {
	readonly backend = "s3" as const;
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(config: Extract<ObjectStorageConfig, { backend: "s3" }>) {
		this.bucket = config.bucket;
		this.client = new S3Client({
			region: config.region,
			...(config.endpoint ? { endpoint: config.endpoint } : {}),
			forcePathStyle: config.forcePathStyle,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
			},
		});
	}

	async put(input: PutObjectInput): Promise<{ etag?: string }> {
		assertSafeKey(input.key);
		// Multipart streaming upload: PutObjectCommand requires a known Content-Length,
		// and providers frequently stream video downloads chunked without one.
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: input.key,
				Body: toNodeReadable(input.body),
				ContentType: input.contentType,
			},
		});
		const result = await upload.done();
		return result.ETag ? { etag: result.ETag } : {};
	}

	async get(key: string, range?: ObjectRange): Promise<StoredObject> {
		assertSafeKey(key);
		const result = await this.client
			.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: key,
					...(range ? { Range: toHttpRange(range) } : {}),
				}),
			)
			.catch((err) => {
				const { name } = err as { name?: string };
				if (name === "NoSuchKey") {
					throw missingObject(key);
				}
				if (name === "InvalidRange") {
					throw rangeNotSatisfiable();
				}
				throw err;
			});
		const parsedRange = range
			? parseContentRange(result.ContentRange)
			: undefined;
		return {
			body: toWebReadable(result.Body),
			contentType: result.ContentType ?? contentTypeForKey(key),
			...(result.ContentLength === undefined
				? {}
				: { contentLength: result.ContentLength }),
			...(result.ETag ? { etag: result.ETag } : {}),
			...(parsedRange ? { range: parsedRange } : {}),
		};
	}

	async head(key: string): Promise<Omit<StoredObject, "body">> {
		assertSafeKey(key);
		const result = await this.client
			.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
			.catch((err) => {
				if ((err as { name?: string }).name === "NotFound") {
					throw missingObject(key);
				}
				throw err;
			});
		return {
			contentType: result.ContentType ?? contentTypeForKey(key),
			...(result.ContentLength === undefined
				? {}
				: { contentLength: result.ContentLength }),
			...(result.ETag ? { etag: result.ETag } : {}),
		};
	}

	async delete(key: string): Promise<void> {
		assertSafeKey(key);
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
		);
	}
}
