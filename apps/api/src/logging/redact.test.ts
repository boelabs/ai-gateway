import { redact } from "./operations.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

test("credentials inside free text are scrubbed, the text around them kept", () => {
	assert.deepEqual(
		redact({
			messages: [
				{ role: "user", content: "use sk-abcdef1234567890 to call it" },
				{ role: "user", content: "header Bearer abc.def.ghi.jkl" },
			],
			private_key: "-----BEGIN",
			aws_access_key_id: "AKIA",
		}),
		{
			messages: [
				{ role: "user", content: "use [redacted] to call it" },
				{ role: "user", content: "header Bearer [redacted]" },
			],
			private_key: "[REDACTED]",
			aws_access_key_id: "[REDACTED]",
		},
	);
});

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
