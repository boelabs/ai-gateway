import { GatewayError } from "#core/errors.ts";
import { Readable } from "node:stream";

/** A byte range: from an offset (optionally bounded) or the last `suffix` bytes. */
export type ObjectRange = { start: number; end?: number } | { suffix: number };

export interface StoredObject {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	contentLength?: number;
	etag?: string;
	range?: {
		start: number;
		end: number;
		total: number;
	};
}

export interface PutObjectInput {
	key: string;
	body: ReadableStream<Uint8Array> | Uint8Array;
	contentType: string;
	contentLength?: number;
}

export interface ObjectStore {
	readonly backend: "disabled" | "local" | "s3";
	put: (input: PutObjectInput) => Promise<{ etag?: string }>;
	get: (key: string, range?: ObjectRange) => Promise<StoredObject>;
	head: (key: string) => Promise<Omit<StoredObject, "body">>;
	delete: (key: string) => Promise<void>;
}

export function rangeNotSatisfiable(): GatewayError {
	return new GatewayError({
		class: "bad_request",
		status: 416,
		code: "range_not_satisfiable",
		message: "Requested byte range is not satisfiable",
		publicMessage: "The requested byte range is not satisfiable.",
	});
}

/** Resolves an ObjectRange against a known total size into inclusive [start, end]. */
export function resolveRange(
	range: ObjectRange,
	totalSize: number,
): { start: number; end: number } {
	if ("suffix" in range) {
		if (range.suffix <= 0 || totalSize === 0) {
			throw rangeNotSatisfiable();
		}
		return { start: Math.max(0, totalSize - range.suffix), end: totalSize - 1 };
	}
	const end =
		range.end === undefined
			? totalSize - 1
			: Math.min(range.end, totalSize - 1);
	if (range.start >= totalSize || end < range.start) {
		throw rangeNotSatisfiable();
	}
	return { start: range.start, end };
}

export function missingObject(key: string, cause?: unknown): GatewayError {
	return new GatewayError({
		class: "not_found",
		code: "object_not_found",
		message: `Object not found: ${key}`,
		cause,
	});
}

export function assertSafeKey(key: string): void {
	if (!key || key.startsWith("/") || key.includes("\\") || key.includes("..")) {
		throw new GatewayError({
			class: "server",
			message: `Unsafe object key: ${key}`,
		});
	}
}

export function toNodeReadable(
	body: ReadableStream<Uint8Array> | Uint8Array,
): Readable {
	return body instanceof Uint8Array
		? Readable.from(body)
		: Readable.fromWeb(body);
}

export function contentTypeForKey(key: string): string {
	if (key.endsWith(".mp4")) {
		return "video/mp4";
	}
	if (key.endsWith(".webm")) {
		return "video/webm";
	}
	if (key.endsWith(".png")) {
		return "image/png";
	}
	if (key.endsWith(".jpg") || key.endsWith(".jpeg")) {
		return "image/jpeg";
	}
	return "application/octet-stream";
}
