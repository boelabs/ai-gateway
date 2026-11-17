import { credentialHint } from "./providerCredentials.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("a credential hint shows a long key's last four characters and the base URL's host", () => {
	assert.deepEqual(
		credentialHint({
			apiKey: "sk-ant-api03-abcdefghijklmnop",
			baseUrl: "https://example.openai.azure.com/openai/v1",
			organization: "org-123",
		}),
		{ apiKey: "mnop", baseUrl: "example.openai.azure.com" },
	);
});

test("a credential hint reveals nothing of a short key", () => {
	assert.deepEqual(credentialHint({ apiKey: "short-key" }), {});
});
