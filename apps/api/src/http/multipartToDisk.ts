import { pipeline } from "node:stream/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { GatewayError } from "#core/errors.ts";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Busboy from "busboy";

/**
 * Receives a multipart/form-data body, writing its files to a private temporary directory.
 *
 * Shared by every multipart endpoint so the stream handling is right once: the body is piped with
 * `stream.pipeline`, so a client that aborts, a source that errors or a limit that is crossed
 * destroys every stream and settles the call instead of leaving it waiting forever, and the
 * directory is removed whenever the call fails. On success the caller owns `cleanup`.
 */

export interface ReceivedFile {
	field: string;
	path: string;
	/** As sent by the client; callers sanitize it before using it. */
	filename: string | undefined;
	sizeBytes: number;
}

export interface ReceivedMultipart {
	/** Every text field in arrival order, duplicates included. */
	fields: [name: string, value: string][];
	files: ReceivedFile[];
	cleanup: () => Promise<void>;
}

export interface MultipartLimits {
	files: number;
	fileSize: number;
	fields: number;
	fieldSize: number;
	parts: number;
	/** Bytes across every file part. */
	totalFileBytes: number;
}

export interface MultipartOptions {
	request: Request;
	tmpPrefix: string;
	limits: MultipartLimits;
	/** Builds this endpoint's 400 for a malformed or over-limit body. */
	error: (message: string, param: string | null) => GatewayError;
	/**
	 * Decides whether a file part is wanted, given the ones already accepted. Return an error to
	 * reject the body, or null to keep the part.
	 */
	acceptFile: (field: string, accepted: ReceivedFile[]) => GatewayError | null;
	/** The error for a file part over `limits.fileSize`. */
	fileTooLarge: (file: ReceivedFile) => GatewayError;
}

export async function receiveMultipart(
	options: MultipartOptions,
): Promise<ReceivedMultipart> {
	const { request, limits, error } = options;
	const contentType = request.headers.get("content-type");
	if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
		throw error("Content-Type must be multipart/form-data", null);
	}
	if (!request.body) {
		throw error("Missing multipart body", null);
	}

	const dir = await mkdtemp(join(tmpdir(), options.tmpPrefix));
	const cleanup = () => rm(dir, { recursive: true, force: true });
	const fields: [string, string][] = [];
	const files: ReceivedFile[] = [];
	const writes: Promise<void>[] = [];
	let failure: GatewayError | null = null;
	let totalBytes = 0;

	const source = Readable.fromWeb(
		request.body as import("node:stream/web").ReadableStream<Uint8Array>,
	);
	const fail = (reason: GatewayError) => {
		failure ??= reason;
		// Stops reading the rest of the body; pipeline then rejects and every stream is destroyed.
		source.destroy(failure);
	};
	const abort = () => source.destroy(new Error("request aborted"));
	request.signal.addEventListener("abort", abort, { once: true });

	try {
		const bb = Busboy({
			headers: Object.fromEntries(request.headers.entries()),
			limits: {
				files: limits.files,
				fileSize: limits.fileSize,
				fields: limits.fields,
				fieldSize: limits.fieldSize,
				parts: limits.parts,
			},
		});
		bb.on("field", (name, value, info) => {
			if (info.valueTruncated) {
				fail(error(`Field "${name}" exceeds ${limits.fieldSize} bytes`, name));
				return;
			}
			fields.push([name, value]);
		});
		bb.on("file", (name, stream, info) => {
			const rejected = options.acceptFile(name, files);
			if (rejected) {
				stream.resume();
				fail(rejected);
				return;
			}
			const file: ReceivedFile = {
				field: name,
				path: join(dir, randomUUID()),
				filename: info.filename,
				sizeBytes: 0,
			};
			files.push(file);
			stream.on("data", (chunk: Buffer) => {
				file.sizeBytes += chunk.length;
				totalBytes += chunk.length;
				if (totalBytes > limits.totalFileBytes) {
					fail(
						error(
							"Multipart body exceeds the configured aggregate limit",
							null,
						),
					);
				}
			});
			stream.on("limit", () => fail(options.fileTooLarge(file)));
			const write = pipeline(
				stream,
				createWriteStream(file.path, { flags: "wx" }),
			);
			// Observed here so a write that fails after the body failed is never unhandled.
			write.catch(() => undefined);
			writes.push(write);
		});
		bb.on("filesLimit", () =>
			fail(error(`At most ${limits.files} file parts are allowed`, null)),
		);
		bb.on("fieldsLimit", () => fail(error("Too many multipart fields", null)));
		bb.on("partsLimit", () => fail(error("Too many multipart parts", null)));

		await pipeline(source, bb);
		await Promise.all(writes);
		if (failure) {
			throw failure;
		}
		return { fields, files, cleanup };
	} catch (cause) {
		await Promise.allSettled(writes);
		await cleanup();
		if (failure) {
			throw failure;
		}
		if (GatewayError.is(cause)) {
			throw cause;
		}
		throw error(
			cause instanceof Error ? cause.message : "Invalid multipart body",
			null,
		);
	} finally {
		request.signal.removeEventListener("abort", abort);
	}
}
