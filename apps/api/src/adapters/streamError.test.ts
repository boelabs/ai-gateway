import { must, streamOf } from "#test-support/adapters.ts";
import type { AdapterContext } from "./types.ts";
import { GatewayError } from "#core/errors.ts";
import { getAdapter } from "./registry.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import "./index.ts";

const ctx: AdapterContext = {
	upstreamModel: "m",
	credentials: { apiKey: "k", baseUrl: "https://upstream.test/v1" },
	meta: {
		capabilities: {
			tools: false,
			vision: false,
			reasoning: false,
			structuredOutputs: false,
		},
	},
	transport: "chat_completions",
	requestId: "t",
};

const chunk = (extra: Record<string, unknown>) =>
	`data: ${JSON.stringify({
		id: "c",
		model: "m",
		choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
		...extra,
	})}\n\n`;

async function drain(adapterKey: string, payload: string) {
	const adapter = getAdapter(adapterKey);
	assert.ok(adapter);
	const out: unknown[] = [];
	for await (const item of must(adapter, "chat").parseStream(
		streamOf(payload),
		ctx,
	)) {
		out.push(item);
	}
	return out;
}

test("error: null on a chunk does not end the stream", async () => {
	for (const key of ["openaicompatible", "vercel"]) {
		const chunks = await drain(
			key,
			`${chunk({ error: null })}data: [DONE]\n\n`,
		);
		assert.ok(chunks.length > 0, key);
	}
});

test("an error inside a 200 stream is classified from its body, with no invented status", async () => {
	for (const [error, cls] of [
		[{ message: "Rate limit reached", type: "rate_limit_error" }, "rate_limit"],
		[
			{ message: "context length exceeded", code: "context_length_exceeded" },
			"context_window",
		],
		[{ message: "Provider returned error", code: 429 }, "rate_limit"],
		[{ message: "boom" }, "server"],
	] as const) {
		for (const key of ["openaicompatible", "vercel"]) {
			await assert.rejects(
				drain(key, `${chunk({})}data: ${JSON.stringify({ error })}\n\n`),
				(caught) =>
					GatewayError.is(caught) &&
					caught.class === cls &&
					caught.provider?.status === undefined,
				`${key}: ${JSON.stringify(error)}`,
			);
		}
	}
});
