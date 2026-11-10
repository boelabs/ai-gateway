import { receiveMultipart } from "./multipartToDisk.ts";
import { GatewayError } from "#core/errors.ts";
import { readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { test } from "node:test";

const BOUNDARY = "----itest";
const PREFIX = `ai-gateway-mptest-${process.pid}-`;

function options(request: Request, totalFileBytes = 1_000_000) {
	return {
		request,
		tmpPrefix: PREFIX,
		limits: {
			files: 2,
			fileSize: 1_000_000,
			fields: 8,
			fieldSize: 1024,
			parts: 10,
			totalFileBytes,
		},
		error: (message: string) =>
			new GatewayError({ class: "bad_request", message }),
		acceptFile: () => null,
		fileTooLarge: () =>
			new GatewayError({ class: "bad_request", message: "big" }),
	};
}

function multipartRequest(body: ReadableStream<Uint8Array>): Request {
	return new Request("http://gateway.test/", {
		method: "POST",
		headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
		body,
		duplex: "half",
	} as RequestInit);
}

const head = new TextEncoder().encode(
	`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
);

async function leftovers(): Promise<string[]> {
	return (await readdir(tmpdir())).filter((name) => name.startsWith(PREFIX));
}

test("a body that fails mid-upload settles the call and removes its files", async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(head);
			controller.enqueue(new Uint8Array(1024));
			controller.error(new Error("connection reset"));
		},
	});
	await assert.rejects(receiveMultipart(options(multipartRequest(body))));
	assert.deepEqual(await leftovers(), []);
});

test("a body over the aggregate limit is refused and cleaned up", async () => {
	let sent = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent === 0) {
				controller.enqueue(head);
			}
			sent += 1;
			controller.enqueue(new Uint8Array(4096));
		},
	});
	await assert.rejects(
		receiveMultipart(options(multipartRequest(body), 16_384)),
		/aggregate limit/u,
	);
	assert.deepEqual(await leftovers(), []);
});
