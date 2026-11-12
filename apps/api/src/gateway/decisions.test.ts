import type {
	CanonicalDecisionRequest,
	DecisionQuestion,
} from "#core/decisions.ts";
import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import { jsonResponse, withStubbedFetch } from "#test-support/fetch.ts";
import { azureopenaiAdapter } from "#adapters/azureopenai/index.ts";
import { openrouterAdapter } from "#adapters/openrouter/index.ts";
import { assertDecisionRequestSupported } from "./decisionValidation.ts";
import type { Adapter, AdapterContext } from "#adapters/types.ts";
import { typesafeAdapter } from "#adapters/typesafe/index.ts";
import { resolveModelMetadata } from "#catalog/index.ts";
import { openaiAdapter } from "#adapters/openai/index.ts";
import { googleAdapter } from "#adapters/google/index.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import { executeDecisions } from "./executor.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function candidate(adapter: Adapter, model: string): DeploymentCandidate {
	return {
		row: { id: "dep-1" } as DeploymentCandidate["row"],
		adapter,
		upstreamModel: model,
		meta: resolveModelMetadata(adapter.key, model),
	};
}

function request(
	questions: DecisionQuestion[],
	content: CanonicalDecisionRequest["input"][number] = {
		type: "message",
		role: "user",
		content: [{ type: "text", text: "A ticket" }],
	},
): CanonicalDecisionRequest {
	return { model: "decide", input: [content], questions };
}

const binary: DecisionQuestion = {
	key: "urgent",
	kind: "binary",
	instructions: [{ type: "text", text: "Urgent?" }],
};

function rejects(
	req: CanonicalDecisionRequest,
	target: DeploymentCandidate,
	pattern: RegExp,
) {
	assert.throws(() => assertDecisionRequestSupported(req, target), pattern);
}

test("decision eligibility follows each model's catalog profile", () => {
	const box: DecisionQuestion = { key: "where", kind: "box", instructions: [] };
	assertDecisionRequestSupported(
		request([box]),
		candidate(typesafeAdapter, "jev-1.14.0"),
	);
	rejects(
		request([box]),
		candidate(typesafeAdapter, "jev-1.13.0"),
		/box questions/u,
	);
	rejects(
		request([box]),
		candidate(googleAdapter, "gemini-decision-1"),
		/box questions/u,
	);

	const many = request(Array.from({ length: 401 }, () => binary));
	rejects(
		many,
		candidate(openaiAdapter, "gpt-6-luna"),
		/at most 400 questions/u,
	);
	assertDecisionRequestSupported(
		many,
		candidate(googleAdapter, "gemini-decision-1"),
	);
});

test("decision eligibility checks media against the transport's content inputs", () => {
	const audio = request([binary], {
		type: "message",
		role: "user",
		content: [
			{
				type: "audio",
				source: {
					kind: "url",
					url: "https://x.test/a.mp3",
					mimeType: "audio/mp3",
				},
			},
		],
	});
	assertDecisionRequestSupported(
		audio,
		candidate(googleAdapter, "gemini-decision-1"),
	);
	rejects(audio, candidate(openaiAdapter, "gpt-6-luna"), /audio input/u);

	const remoteImage = request([binary], {
		type: "message",
		role: "user",
		content: [
			{ type: "image", source: { kind: "url", url: "https://x.test/a.png" } },
		],
	});
	assertDecisionRequestSupported(
		remoteImage,
		candidate(openaiAdapter, "gpt-6-luna"),
	);
	rejects(
		remoteImage,
		candidate(typesafeAdapter, "jev-1.14.0"),
		/inline data, not a URL/u,
	);

	const webp = request([binary], {
		type: "message",
		role: "user",
		content: [
			{
				type: "image",
				source: { kind: "data", data: PNG, mimeType: "image/webp" },
			},
		],
	});
	rejects(webp, candidate(typesafeAdapter, "jev-1.14.0"), /image\/webp/u);

	const imageInQuestion = request([
		{
			...binary,
			instructions: [
				{
					type: "image",
					source: { kind: "data", data: PNG, mimeType: "image/png" },
				},
			],
		},
	]);
	assertDecisionRequestSupported(
		imageInQuestion,
		candidate(typesafeAdapter, "jev-1.14.0"),
	);
	rejects(
		imageInQuestion,
		candidate(googleAdapter, "gemini-decision-1"),
		/only text in questions/u,
	);
});

test("string-keyed transports reject a boolean and a string choice of the same text", () => {
	const typed = request([
		{
			key: "flag",
			kind: "choice",
			instructions: [{ type: "text", text: "?" }],
			options: [{ value: true }, { value: "true" }],
		},
	]);
	assertDecisionRequestSupported(typed, candidate(openaiAdapter, "gpt-6-luna"));
	rejects(typed, candidate(googleAdapter, "gemini-decision-1"), /same text/u);
});

function context(
	model: string,
	transport: UpstreamTransport,
	adapter: Adapter,
): AdapterContext {
	return {
		upstreamModel: model,
		credentials: { apiKey: "secret" },
		meta: resolveModelMetadata(adapter.key, model),
		transport,
		requestId: "req-decide",
	};
}

const imageRequest = request([binary], {
	type: "message",
	role: "user",
	content: [
		{ type: "text", text: "Look:" },
		{
			type: "image",
			source: { kind: "data", data: PNG, mimeType: "image/png" },
		},
	],
});

test("each provider's decisions request goes to its own endpoint with its own auth", async () => {
	const cases = [
		{
			adapter: openaiAdapter,
			model: "gpt-6-luna",
			transport: "openai_decisions",
			url: "https://api.openai.com/v1/decisions",
			header: ["authorization", "Bearer secret"],
			reply: {
				answers: [{ type: "predicate", name: "q0", probability: 0.8 }],
				usage: { input_tokens: 9, output_tokens: 0 },
			},
		},
		{
			adapter: googleAdapter,
			model: "gemini-decision-1",
			transport: "gemini_decisions",
			url: "https://generativelanguage.googleapis.com/v1beta/decisions",
			header: ["x-goog-api-key", "secret"],
			reply: {
				answers: { urgent: { type: "noul", noul: 0.8, confidence: 0.8 } },
				usage: { total_input_tokens: 9 },
			},
		},
		{
			adapter: typesafeAdapter,
			model: "jev-1.14.0",
			transport: "systemone",
			url: "https://api.typesafe.ai/v1/systemone",
			header: ["typesafe-danger-zone-images", "true"],
			reply: {
				model: "jev-1.14.0",
				answers: { urgent: { type: "noul", noul: 0.8 } },
				usage: { input_tokens: 9, output_tokens: 1 },
			},
		},
		{
			adapter: openrouterAdapter,
			model: "typesafe/jev-1.14",
			transport: "openrouter_decisions",
			url: "https://openrouter.ai/api/alpha/decisions",
			header: ["authorization", "Bearer secret"],
			reply: {
				id: "gen-dec-1",
				model: "typesafe/jev-1.14",
				answers: { urgent: { type: "noul", noul: 0.8 } },
				usage: { input_tokens: 9, output_tokens: 1, cost: 0.0001 },
			},
		},
	] as const;
	for (const item of cases) {
		await withStubbedFetch(
			async (input, init) => {
				assert.equal(String(input), item.url);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get(item.header[0]), item.header[1]);
				const body = JSON.parse(String(init?.body)) as { model: string };
				assert.equal(body.model, item.model);
				return jsonResponse(item.reply);
			},
			async () => {
				const result = await executeDecisions(
					item.adapter,
					imageRequest,
					context(item.model, item.transport, item.adapter),
				);
				const [answer] = result.response.answers;
				assert.equal(answer?.kind, "binary");
				assert.equal(
					answer?.kind === "binary" ? answer.probability : null,
					0.8,
				);
				assert.equal(result.response.usage?.promptTokens, 9);
			},
		);
	}
});

test("Azure OpenAI decisions use the resource's v1 route, api-key, and one user message", async () => {
	const conversation: CanonicalDecisionRequest = {
		model: "decide",
		input: [
			{
				type: "message",
				role: "developer",
				content: [{ type: "text", text: "Triage tickets." }],
			},
			{
				type: "message",
				role: "user",
				content: [{ type: "json", data: { ticket: "Charged twice" } }],
			},
		],
		questions: [binary],
		promptCache: { key: "tickets" },
		user: "end-user-1",
	};
	assertDecisionRequestSupported(
		conversation,
		candidate(azureopenaiAdapter, "gpt-6-luna"),
	);
	await withStubbedFetch(
		async (input, init) => {
			assert.equal(
				String(input),
				"https://example-resource.openai.azure.com/openai/v1/decisions",
			);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("api-key"), "secret");
			assert.equal(headers.get("authorization"), null);
			assert.deepEqual(JSON.parse(String(init?.body)), {
				model: "luna-deployment",
				input: [
					{
						type: "message",
						role: "user",
						content:
							'Developer:\nTriage tickets.\n\nUser:\n{"ticket":"Charged twice"}',
					},
				],
				questions: [{ type: "predicate", name: "q0", instructions: "Urgent?" }],
			});
			return jsonResponse({
				model: "gpt-6-luna",
				answers: [{ type: "predicate", name: "q0", probability: 0.3 }],
				usage: { input_tokens: 20, output_tokens: 0, total_tokens: 20 },
			});
		},
		async () => {
			const result = await executeDecisions(azureopenaiAdapter, conversation, {
				...context("luna-deployment", "openai_decisions", azureopenaiAdapter),
				credentials: {
					apiKey: "secret",
					baseUrl: "https://example-resource.openai.azure.com",
				},
				meta: resolveModelMetadata("azureopenai", "gpt-6-luna"),
			});
			assert.deepEqual(result.response.answers, [
				{ kind: "binary", probability: 0.3 },
			]);
		},
	);
});

test("a decisions answer of the wrong kind is a retryable protocol error", async () => {
	await withStubbedFetch(
		async () =>
			jsonResponse({ answers: { urgent: { type: "choice", choice: "a" } } }),
		async () => {
			await assert.rejects(
				() =>
					executeDecisions(
						googleAdapter,
						request([binary]),
						context("gemini-decision-1", "gemini_decisions", googleAdapter),
					),
				(error: unknown) =>
					(error as { code?: string }).code === "upstream_protocol_error",
			);
		},
	);
});
