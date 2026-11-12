import { withStubbedFetch } from "#test-support/fetch.ts";
import type { AdapterContext } from "#adapters/types.ts";
import { upstreamFetch } from "./instrumentedTransport.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const ctx = { requestId: "t" } as AdapterContext;

test("a redirect to another origin is followed without the credentials", async () => {
	const seen: { url: string; headers: Headers }[] = [];
	await withStubbedFetch(
		(input, init) => {
			seen.push({ url: String(input), headers: new Headers(init?.headers) });
			if (seen.length === 1) {
				return Response.redirect("https://storage.example/signed?sig=1", 302);
			}
			return new Response("ok");
		},
		async () => {
			const response = await upstreamFetch(
				ctx,
				"https://api.example/v1/files/1",
				{
					headers: {
						authorization: "Bearer secret",
						"x-api-key": "secret",
						"x-custom-credential": "secret",
						accept: "application/octet-stream",
					},
				},
			);
			assert.equal(await response.text(), "ok");
		},
	);
	assert.equal(seen[1]?.url, "https://storage.example/signed?sig=1");
	assert.equal(seen[1]?.headers.get("authorization"), null);
	assert.equal(seen[1]?.headers.get("x-api-key"), null);
	assert.equal(seen[1]?.headers.get("x-custom-credential"), null);
	assert.equal(seen[1]?.headers.get("accept"), "application/octet-stream");
});

test("a same-origin redirect keeps the credentials", async () => {
	const seen: Headers[] = [];
	await withStubbedFetch(
		(_input, init) => {
			seen.push(new Headers(init?.headers));
			return seen.length === 1
				? new Response(null, {
						status: 307,
						headers: { location: "/v1/other" },
					})
				: new Response("ok");
		},
		async () => {
			await upstreamFetch(ctx, "https://api.example/v1/files/1", {
				headers: { authorization: "Bearer secret" },
			});
		},
	);
	assert.equal(seen[1]?.get("authorization"), "Bearer secret");
});
