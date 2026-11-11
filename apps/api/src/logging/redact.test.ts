import { redact } from "./operations.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("credentials are redacted and token counts are not", () => {
	assert.deepEqual(
		redact({
			max_tokens: 100,
			usage: { input_tokens: 5, prompt_tokens: 5 },
			access_token: "a",
			idToken: "b",
			"x-auth-token": "c",
			api_key: "d",
		}),
		{
			max_tokens: 100,
			usage: { input_tokens: 5, prompt_tokens: 5 },
			access_token: "[REDACTED]",
			idToken: "[REDACTED]",
			"x-auth-token": "[REDACTED]",
			api_key: "[REDACTED]",
		},
	);
});
