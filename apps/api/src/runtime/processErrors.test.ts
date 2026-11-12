import assert from "node:assert/strict";
import { test } from "node:test";

import {
	installProcessErrorHandlers,
	onUnhandledRejection,
} from "./processErrors.ts";

test("an unhandled rejection is logged with its reason and does not throw", () => {
	const written: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		onUnhandledRejection(new Error("redis write failed"));
	} finally {
		process.stderr.write = original;
	}
	const line = written.find((entry) =>
		entry.includes("unhandled promise rejection"),
	);
	assert.ok(line);
	assert.ok(line.includes("redis write failed"));
});

test("the handler is installed once", () => {
	const before = process.listenerCount("unhandledRejection");
	installProcessErrorHandlers();
	installProcessErrorHandlers();
	assert.equal(process.listenerCount("unhandledRejection"), before + 1);
	process.off("unhandledRejection", onUnhandledRejection);
});
