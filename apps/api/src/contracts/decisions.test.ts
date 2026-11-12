import type { CanonicalDecisionResponse } from "#core/decisions.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	openAIDecisionRequestToCanonical,
	openAIDecisionRequestSchema,
	toOpenAIDecisionResponse,
} from "./openai/decisions.ts";

import {
	parseOpenAIDecisionResponse,
	buildOpenAIDecisionBody,
} from "./openai/decisionsTransport.ts";

import {
	geminiDecisionRequestToCanonical,
	geminiDecisionRequestSchema,
	parseGeminiDecisionResponse,
	toGeminiDecisionResponse,
	buildGeminiDecisionBody,
} from "./google/decisions.ts";

import {
	systemOneRequestToCanonical,
	systemOneRequestSchema,
	parseSystemOneResponse,
	toSystemOneResponse,
	buildSystemOneBody,
	parseSystemOneBody,
} from "./typesafe/systemone.ts";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const openAIRequest = openAIDecisionRequestToCanonical(
	openAIDecisionRequestSchema.parse({
		model: "decide",
		input: [
			{ role: "developer", content: "You triage support tickets." },
			{
				role: "user",
				content: [
					{ type: "input_text", text: "Charged twice." },
					{ type: "input_image", image_url: `data:image/png;base64,${PNG}` },
				],
			},
		],
		questions: [
			{ type: "predicate", name: "refund", instructions: "Wants a refund." },
			{
				type: "choice",
				name: "team",
				instructions: "Owning team.",
				choices: [
					{ value: "billing", description: "Invoices." },
					{ value: true },
				],
			},
			{
				type: "score",
				instructions: "Urgency.",
				levels: [{ label: "low" }, { label: "high", description: "Today." }],
			},
		],
		prompt_cache_key: "tickets",
		safety_identifier: "user-1",
	}),
);

test("OpenAI contract parses into canonical questions in order, keeping typed choices", () => {
	assert.equal(openAIRequest.questions.length, 3);
	assert.equal(openAIRequest.questions[0]?.kind, "binary");
	assert.equal(openAIRequest.questions[2]?.key, null);
	const [, choice] = openAIRequest.questions;
	assert.ok(choice?.kind === "choice");
	assert.deepEqual(
		choice.options.map((option) => option.value),
		["billing", true],
	);
	assert.deepEqual(openAIRequest.promptCache, { key: "tickets" });
	assert.equal(openAIRequest.user, "user-1");
	const [, image] = openAIRequest.input;
	assert.ok(image?.type === "message");
	assert.deepEqual(image.content[1], {
		type: "image",
		source: { kind: "data", data: PNG, mimeType: "image/png" },
	});
});

test("OpenAI contract rejects duplicate choices but allows a string and a boolean of the same text", () => {
	const base = {
		model: "m",
		input: "x",
		questions: [
			{
				type: "choice",
				instructions: "?",
				choices: [{ value: "true" }, { value: true }],
			},
		],
	};
	assert.ok(openAIDecisionRequestSchema.safeParse(base).success);
	assert.equal(
		openAIDecisionRequestSchema.safeParse({
			...base,
			questions: [
				{
					type: "choice",
					instructions: "?",
					choices: [{ value: "a" }, { value: "a" }],
				},
			],
		}).success,
		false,
	);
});

test("OpenAI transport names questions by position and maps answers back", () => {
	const body = buildOpenAIDecisionBody(openAIRequest, "gpt-6-luna");
	assert.equal(body.model, "gpt-6-luna");
	assert.deepEqual(
		(body.questions as Array<{ name: string }>).map(
			(question) => question.name,
		),
		["q0", "q1", "q2"],
	);
	assert.equal(body.prompt_cache_key, "tickets");
	assert.equal(body.safety_identifier, "user-1");

	const response = parseOpenAIDecisionResponse(
		{
			model: "gpt-6-luna-2026-10-01",
			answers: [
				{ type: "predicate", name: "q0", probability: 0.9 },
				{
					type: "choice",
					name: "q1",
					choice: true,
					confidence: 0.7,
					probabilities: [
						{ value: "billing", probability: 0.3 },
						{ value: true, probability: 0.7 },
					],
				},
				{ type: "refusal", name: "q2" },
			],
			usage: {
				input_tokens: 100,
				input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
				output_tokens: 0,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 100,
			},
		},
		openAIRequest,
	);
	assert.deepEqual(response.answers, [
		{ kind: "binary", probability: 0.9 },
		{ kind: "choice", choice: 1, probabilities: [0.3, 0.7], confidence: 0.7 },
		{ kind: "refusal" },
	]);
	assert.equal(response.usage?.cacheReadTokens, 40);

	const rendered = toOpenAIDecisionResponse(openAIRequest, response);
	const answers = rendered.answers as Record<string, unknown>[];
	assert.equal(answers[1]?.choice, true);
	assert.deepEqual(answers[2], { type: "refusal", name: null });
});

test("OpenAI transport rejects a response missing an answer as a protocol error", () => {
	assert.throws(
		() => parseOpenAIDecisionResponse({ answers: [] }, openAIRequest),
		/no valid answer for question 0/u,
	);
});

test("Gemini transport flattens a conversation and keys questions for its map", () => {
	const body = buildGeminiDecisionBody(openAIRequest, "gemini-decision-1");
	const input = body.input as Record<string, unknown>[];
	assert.deepEqual(input[0], {
		type: "text",
		text: "Developer:\nYou triage support tickets.\n\nUser:\nCharged twice.",
	});
	assert.deepEqual(input[1], {
		type: "image",
		data: PNG,
		mime_type: "image/png",
	});
	const questions = body.questions as Record<string, Record<string, unknown>>;
	assert.deepEqual(Object.keys(questions), ["refund", "team", "q2"]);
	assert.deepEqual(questions.team?.criteria, {
		billing: "Invoices.",
		true: "",
	});
	assert.deepEqual(questions.q2?.criteria, ["low", "high: Today."]);
});

test("Gemini contract round-trips its own request and response shapes", () => {
	const request = geminiDecisionRequestToCanonical(
		geminiDecisionRequestSchema.parse({
			model: "models/decide",
			input: [
				{ type: "text", text: "Ticket" },
				{ type: "audio", uri: "https://x.test/a.mp3", mime_type: "audio/mp3" },
			],
			questions: {
				urgent: {
					type: "noul",
					instructions: "Urgent?",
					criteria: { true_description: "Needs a reply today." },
				},
				tone: {
					type: "choice",
					instructions: "Tone",
					criteria: { calm: "", angry: "" },
				},
			},
		}),
	);
	assert.equal(request.model, "decide");
	const wire = buildGeminiDecisionBody(request, "gemini-decision-1");
	assert.deepEqual((wire.questions as Record<string, unknown>).urgent, {
		type: "noul",
		instructions: "Urgent?",
		criteria: { true_description: "Needs a reply today." },
	});
	const parsed = parseGeminiDecisionResponse(
		{
			answers: {
				urgent: { type: "noul", noul: 0.2, confidence: 0.8 },
				tone: {
					type: "choice",
					choice: "angry",
					probabilities: { angry: 0.6, calm: 0.4 },
					confidence: 0.6,
				},
			},
			usage: {
				total_input_tokens: 50,
				input_tokens_by_modality: [{ modality: "audio", tokens: 30 }],
				total_output_tokens: 0,
				total_tokens: 50,
			},
		},
		request,
	);
	assert.deepEqual(parsed.answers[1], {
		kind: "choice",
		choice: 1,
		probabilities: [0.4, 0.6],
		confidence: 0.6,
	});
	assert.equal(parsed.usage?.promptAudioTokens, 30);
	const rendered = toGeminiDecisionResponse(request, parsed);
	assert.deepEqual(rendered.answers, {
		urgent: { type: "noul", noul: 0.2, confidence: 0.8 },
		tone: {
			type: "choice",
			choice: "angry",
			probabilities: { calm: 0.4, angry: 0.6 },
			confidence: 0.6,
		},
	});
	assert.equal(rendered.prompt_feedback, undefined);
});

test("Gemini blocked input becomes all refusals and renders back as prompt_feedback", () => {
	const request = geminiDecisionRequestToCanonical(
		geminiDecisionRequestSchema.parse({
			model: "decide",
			input: "x",
			questions: { a: { type: "noul", instructions: "?" } },
		}),
	);
	const parsed = parseGeminiDecisionResponse(
		{ answers: {}, prompt_feedback: { block_reason: "safety" } },
		request,
	);
	assert.deepEqual(parsed.answers, [{ kind: "refusal" }]);
	assert.deepEqual(toGeminiDecisionResponse(request, parsed).prompt_feedback, {
		block_reason: "safety",
	});
});

test("Gemini contract rejects invalid question keys and too few choices", () => {
	assert.equal(
		geminiDecisionRequestSchema.safeParse({
			model: "m",
			input: "x",
			questions: { "bad key": { type: "noul", instructions: "?" } },
		}).success,
		false,
	);
	assert.equal(
		geminiDecisionRequestSchema.safeParse({
			model: "m",
			input: "x",
			questions: {
				a: { type: "choice", instructions: "?", criteria: { only: "" } },
			},
		}).success,
		false,
	);
});

const systemOneRequest = systemOneRequestToCanonical(
	systemOneRequestSchema.parse({
		model: "decide",
		state: { photo: "img-1", note: "Dog at the park" },
		assets: { "img-1": { format: "png", data_base64: PNG } },
		questions: {
			collar: {
				type: "noul",
				instructions: "Is the dog in img-1 wearing a collar?",
			},
			where: { type: "box", instructions: "The dog's collar" },
			size: { type: "score", criteria: ["small", { label: "large" }] },
		},
	}),
);

test("TypeSafe contract resolves asset references in place and after structured state", () => {
	const [input] = systemOneRequest.input;
	assert.ok(input?.type === "message");
	assert.deepEqual(
		input.content.map((part) => part.type),
		["json", "text", "image"],
	);
	const [collar] = systemOneRequest.questions;
	assert.deepEqual(
		collar?.instructions.map((part) => part.type),
		["text", "image", "text"],
	);
	assert.equal(systemOneRequest.questions[1]?.kind, "box");
});

test("TypeSafe transport sends images as assets and flags the images header", () => {
	const { body, usesImages } = buildSystemOneBody(
		systemOneRequest,
		"jev-1.14.0",
	);
	assert.equal(usesImages, true);
	const assets = body.assets as Record<string, Record<string, unknown>>;
	const refs = Object.keys(assets);
	assert.equal(refs.length, 2);
	assert.deepEqual(assets[refs[0] ?? ""], {
		type: "image",
		format: "png",
		data_base64: PNG,
	});
	const questions = body.questions as Record<string, Record<string, unknown>>;
	const instructions = questions.collar?.instructions as unknown[];
	assert.equal(instructions[1], refs[1]);
	assert.deepEqual(questions.size?.criteria, ["small", { label: "large" }]);
});

test("TypeSafe transport parses box, refusal and usage cost; contract renders them", () => {
	const response: CanonicalDecisionResponse = parseSystemOneResponse(
		{
			id: "gen-dec-1",
			model: "typesafe/jev-1.14",
			provider: "TypeSafe",
			answers: {
				collar: { type: "noul", noul: 0.95 },
				where: {
					type: "box",
					box: { top: 0.1, bottom: 0.3, left: 0.4, right: 0.6 },
					confidence: null,
				},
				size: { type: "refusal" },
			},
			usage: { input_tokens: 476, output_tokens: 3, cost: 0.000_02 },
		},
		systemOneRequest,
	);
	assert.equal(response.provider, "TypeSafe");
	assert.equal(response.usage?.providerCostCents, 0.002);
	assert.deepEqual(response.answers[1], {
		kind: "box",
		box: { top: 0.1, bottom: 0.3, left: 0.4, right: 0.6 },
		confidence: null,
	});
	const rendered = toSystemOneResponse(systemOneRequest, response);
	assert.deepEqual(rendered.answers, {
		collar: { type: "noul", noul: 0.95 },
		where: {
			type: "box",
			box: { top: 0.1, bottom: 0.3, left: 0.4, right: 0.6 },
			confidence: null,
		},
		size: { type: "refusal" },
	});
	assert.deepEqual(rendered.usage, { input_tokens: 476, output_tokens: 3 });
});

test("TypeSafe multipart bodies inline their image parts as base64 assets", async () => {
	const form = new FormData();
	form.set(
		"request",
		JSON.stringify({
			model: "decide",
			state: "photo-1",
			assets: { "photo-1": { part: "file-1" } },
			questions: { q: { type: "noul", instructions: "A dog?" } },
		}),
	);
	form.set(
		"file-1",
		new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }),
		"dog.png",
	);
	const encoded = new Response(form);
	const contentType = encoded.headers.get("content-type") ?? "";
	const bytes = new Uint8Array(await encoded.arrayBuffer());
	const body = (await parseSystemOneBody(contentType, bytes)) as {
		assets: Record<string, Record<string, unknown>>;
	};
	assert.deepEqual(body.assets["photo-1"], { data_base64: PNG, format: "png" });
	assert.ok(systemOneRequestSchema.safeParse(body).success);
});
