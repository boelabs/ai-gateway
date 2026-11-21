import { createBoelabsGateway } from "./boelabs-gateway-provider.ts";
import { json, mockGateway } from "./test-support.ts";
import { describe, expect, test } from "bun:test";

const models = [
	{
		id: "general",
		object: "model",
		created: 1,
		owned_by: "Boelabs",
		architecture: {
			modality: "text->text",
			input_modalities: ["text"],
			output_modalities: ["text"],
		},
		top_provider: { context_length: 200_000 },
		pricing: { prompt: "0.000001" },
		operations: [{ id: "text.generate", endpoints: ["/v1/responses"] }],
		supported_parameters: ["temperature"],
		endpoint_count: 2,
	},
	{
		id: "video-default",
		object: "model",
		created: 1,
		owned_by: "Boelabs",
		architecture: {
			modality: "text->video",
			input_modalities: ["text"],
			output_modalities: ["video"],
		},
		top_provider: {},
		pricing: {},
		operations: [{ id: "video.generate", endpoints: ["/v1/videos"] }],
		supported_parameters: [],
		endpoint_count: 1,
	},
];

describe("model catalog", () => {
	test("lists models without an API key and filters by operation", async () => {
		const previous = process.env.BOELABS_AI_GATEWAY_API_KEY;
		delete process.env.BOELABS_AI_GATEWAY_API_KEY;
		try {
			const { provider, requests } = mockGateway(
				[json({ object: "list", data: models })],
				{
					apiKey: undefined,
				},
			);
			const list = await provider.models.list({ operation: "video.generate" });
			expect(list.map((model) => model.id)).toEqual(["video-default"]);
			expect(requests[0]?.url).toBe("https://gateway.test/v1/models");
			expect(requests[0]?.headers.get("authorization")).toBeNull();
		} finally {
			if (previous !== undefined) {
				process.env.BOELABS_AI_GATEWAY_API_KEY = previous;
			}
		}
	});

	test("gets one model and its deployments", async () => {
		const { provider, requests } = mockGateway([
			json(models[0]),
			json({ object: "list", data: [{ id: "dep_1", status: "available" }] }),
		]);
		expect((await provider.models.get("general")).id).toBe("general");
		const deployments = await provider.models.deployments("general");
		expect(deployments[0]?.id).toBe("dep_1");
		expect(requests[1]?.url).toBe(
			"https://gateway.test/v1/models/general/deployments",
		);
		expect(requests[1]?.headers.get("authorization")).toBe("Bearer sk-test");
	});
});

describe("provider settings", () => {
	test("accepts a base URL with or without /v1 and reads the environment lazily", () => {
		const url = (baseURL: string) =>
			(
				createBoelabsGateway({ baseURL, apiKey: "k" }).responses(
					"m",
				) as unknown as {
					config: { url: (path: string) => string };
				}
			).config.url("/responses");
		expect(url("https://gw.test")).toBe("https://gw.test/v1/responses");
		expect(url("https://gw.test/v1/")).toBe("https://gw.test/v1/responses");
		expect(url("https://gw.test/ai")).toBe("https://gw.test/ai/v1/responses");
	});

	test("names the provider and its metadata after `name`", () => {
		const provider = createBoelabsGateway({
			baseURL: "https://gw.test",
			apiKey: "k",
			name: "acme",
		});
		expect(provider("general").provider).toBe("acme.responses");
		expect(provider.chat("general").provider).toBe("acme.chat");
		expect(provider.video("v").provider).toBe("acme.video");
	});

	test("rejects being called with new", () => {
		const provider = createBoelabsGateway({
			baseURL: "https://gw.test",
			apiKey: "k",
		});
		expect(
			() => new (provider as unknown as new (id: string) => unknown)("x"),
		).toThrow();
	});
});
