import { json, mockGateway } from "../test-support.ts";
import { describe, expect, test } from "bun:test";

import {
	experimental_generateVideo as generateVideo,
	experimental_transcribe as transcribe,
	generateSpeech,
	generateImage,
	embedMany,
	rerank,
} from "ai";

describe("media models", () => {
	test("embeddings keep input order and report tokens", async () => {
		const { provider, requests } = mockGateway([
			json({
				object: "list",
				model: "embed",
				data: [
					{ object: "embedding", index: 1, embedding: [0, 1] },
					{ object: "embedding", index: 0, embedding: [1, 0] },
				],
				usage: { prompt_tokens: 6, total_tokens: 6 },
			}),
		]);
		const result = await embedMany({
			model: provider.embedding("embed"),
			values: ["fox", "whale"],
			providerOptions: { boelabsGateway: { dimensions: 2, cache: true } },
		});
		expect(result.embeddings).toEqual([
			[1, 0],
			[0, 1],
		]);
		expect(result.usage.tokens).toBe(6);
		expect(requests[0]?.body).toEqual({
			model: "embed",
			input: ["fox", "whale"],
			encoding_format: "float",
		});
		expect(requests[0]?.headers.get("x-unified-cache")).toBe("true");
	});

	test("image generation sends JSON and returns base64 images", async () => {
		const { provider, requests } = mockGateway([
			json({
				created: 1_760_000_000,
				data: [{ b64_json: "aW1n", revised_prompt: "A red fox" }],
				size: "1024x1024",
				quality: "high",
			}),
		]);
		const result = await generateImage({
			model: provider.image("image-default"),
			prompt: "a fox",
			size: "1024x1024",
			providerOptions: {
				boelabsGateway: { quality: "max", outputFormat: "webp" },
			},
		});
		expect(result.image.base64).toBe("aW1n");
		expect(requests[0]?.url).toBe("https://gateway.test/v1/images/generations");
		expect(requests[0]?.body).toEqual({
			model: "image-default",
			prompt: "a fox",
			n: 1,
			size: "1024x1024",
			quality: "max",
			output_format: "webp",
		});
		expect(result.providerMetadata.boelabsGateway?.images[0]).toMatchObject({
			revisedPrompt: "A red fox",
			quality: "high",
			size: "1024x1024",
			requestId: "req_123",
		});
	});

	test("image edits go multipart with the image and mask", async () => {
		const { provider, requests } = mockGateway([
			json({ created: 1_760_000_000, data: [{ b64_json: "ZWRpdA==" }] }),
		]);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		await generateImage({
			model: provider.image("image-default"),
			prompt: { text: "add a hat", images: [png], mask: png },
		});
		const form = requests[0]?.form;
		expect(requests[0]?.url).toBe("https://gateway.test/v1/images/edits");
		expect(form?.get("prompt")).toBe("add a hat");
		expect(form?.get("model")).toBe("image-default");
		expect(form?.get("image")).toBeInstanceOf(Blob);
		expect(form?.get("mask")).toBeInstanceOf(Blob);
		expect(form?.get("extra_body")).toBeNull();
	});

	test("image aspectRatio goes out with the resolution tier, and size wins over both", async () => {
		const { provider, requests } = mockGateway([
			json({ created: 1_760_000_000, data: [{ b64_json: "aW1n" }] }),
			json({ created: 1_760_000_000, data: [{ b64_json: "aW1n" }] }),
		]);
		const ratio = await generateImage({
			model: provider.image("image-default"),
			prompt: "a fox",
			aspectRatio: "16:9",
			providerOptions: { boelabsGateway: { resolution: "2K" } },
		});
		expect(requests[0]?.body).toEqual({
			model: "image-default",
			prompt: "a fox",
			n: 1,
			aspect_ratio: "16:9",
			resolution: "2K",
		});
		expect(ratio.warnings).toEqual([]);

		const exact = await generateImage({
			model: provider.image("image-default"),
			prompt: "a fox",
			size: "1024x1024",
			aspectRatio: "16:9",
		});
		expect(requests[1]?.body).toMatchObject({ size: "1024x1024" });
		expect(requests[1]?.body).not.toHaveProperty("aspect_ratio");
		expect(exact.warnings).toEqual([
			expect.objectContaining({ type: "other" }),
		]);
	});

	test("serviceMode rides as the model suffix on media models", async () => {
		const { provider, requests } = mockGateway([
			json({ created: 1_760_000_000, data: [{ b64_json: "aW1n" }] }),
			json({
				object: "list",
				model: "embed",
				data: [{ object: "embedding", index: 0, embedding: [1, 0] }],
				usage: { prompt_tokens: 1, total_tokens: 1 },
			}),
		]);
		await generateImage({
			model: provider.image("image-default"),
			prompt: "a fox",
			providerOptions: { boelabsGateway: { serviceMode: "flex" } },
		});
		await embedMany({
			model: provider.embedding("embed"),
			values: ["fox"],
			providerOptions: { boelabsGateway: { serviceMode: "priority" } },
		});
		expect(requests[0]?.body).toMatchObject({ model: "image-default:flex" });
		expect(requests[1]?.body).toMatchObject({ model: "embed:priority" });
	});

	test("image edits carry extra_body as a JSON field", async () => {
		const { provider, requests } = mockGateway([
			json({ created: 1_760_000_000, data: [{ b64_json: "ZWRpdA==" }] }),
		]);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		const extraBody = {
			image_config: { aspect_ratio: "auto", image_size: "2K" },
		};
		await generateImage({
			model: provider.image("image-default"),
			prompt: { text: "add a hat", images: [png] },
			providerOptions: { boelabsGateway: { quality: "high", extraBody } },
		});
		const form = requests[0]?.form;
		expect(requests[0]?.url).toBe("https://gateway.test/v1/images/edits");
		expect(form?.get("quality")).toBe("high");
		expect(JSON.parse(String(form?.get("extra_body")))).toEqual(extraBody);
	});

	test("transcription asks for verbose_json when timestamps are wanted", async () => {
		const { provider, requests } = mockGateway([
			json({
				task: "transcribe",
				language: "es",
				duration: 2.5,
				text: "Hola mundo",
				segments: [{ id: 0, start: 0, end: 2.5, text: "Hola mundo" }],
				words: [
					{ word: "Hola", start: 0, end: 1 },
					{ word: "mundo", start: 1, end: 2.5 },
				],
			}),
		]);
		const result = await transcribe({
			model: provider.transcription("transcribe"),
			audio: new Uint8Array([1, 2, 3]),
			timestampGranularities: ["word", "segment"],
			providerOptions: {
				boelabsGateway: { keywords: ["AI Gateway"], languages: ["es", "en"] },
			},
		});
		expect(result.text).toBe("Hola mundo");
		expect(result.language).toBe("es");
		expect(result.durationInSeconds).toBe(2.5);
		expect(result.segments).toEqual([
			{ text: "Hola mundo", startSecond: 0, endSecond: 2.5 },
		]);
		const form = requests[0]?.form;
		expect(form?.get("response_format")).toBe("verbose_json");
		expect(form?.getAll("timestamp_granularities[]")).toEqual([
			"word",
			"segment",
		]);
		expect(form?.getAll("keywords[]")).toEqual(["AI Gateway"]);
		expect(form?.getAll("languages[]")).toEqual(["es", "en"]);
		expect(form?.get("file")).toBeInstanceOf(Blob);
	});

	test("speech returns the audio bytes", async () => {
		const { provider, requests } = mockGateway([
			new Response(new Uint8Array([82, 73, 70, 70]), {
				headers: { "content-type": "audio/wav" },
			}),
		]);
		const result = await generateSpeech({
			model: provider.speech("speech"),
			text: "Have a wonderful day!",
			voice: "Kore",
			instructions: "cheerful",
			outputFormat: "wav",
		});
		expect([...result.audio.uint8Array]).toEqual([82, 73, 70, 70]);
		expect(requests[0]?.body).toEqual({
			model: "speech",
			input: "Have a wonderful day!",
			voice: "Kore",
			instructions: "cheerful",
			response_format: "wav",
		});
	});

	test("rerank maps the OpenRouter-shaped response", async () => {
		const { provider, requests } = mockGateway([
			json({
				id: "gen-rerank-1",
				model: "reranker",
				results: [
					{ index: 1, relevance_score: 0.9, document: { text: "Paris" } },
					{ index: 0, relevance_score: 0.1, document: { text: "Berlin" } },
				],
				usage: { search_units: 1, cost: 0.002 },
			}),
		]);
		const result = await rerank({
			model: provider.reranking("reranker"),
			query: "capital of France",
			documents: ["Berlin", "Paris"],
			topN: 2,
		});
		expect(result.ranking.map((item) => item.document)).toEqual([
			"Paris",
			"Berlin",
		]);
		expect(requests[0]?.body).toEqual({
			model: "reranker",
			query: "capital of France",
			documents: ["Berlin", "Paris"],
			top_n: 2,
		});
	});

	test("video starts a job, polls it and downloads the content", async () => {
		const job = {
			id: "video_1",
			object: "video",
			model: "video-default",
			created_at: 1_760_000_000,
		};
		const { provider, requests } = mockGateway([
			json({ ...job, status: "queued", progress: 0 }),
			json({ ...job, status: "in_progress", progress: 50 }),
			json({
				...job,
				status: "completed",
				progress: 100,
				seconds: "8",
				size: "1280x720",
			}),
			new Response(new Uint8Array([0, 0, 0, 24]), {
				headers: { "content-type": "video/mp4" },
			}),
		]);
		const result = await generateVideo({
			model: provider.video("video-default"),
			prompt: "a mountain at sunset",
			aspectRatio: "16:9",
			duration: 8,
			providerOptions: { boelabsGateway: { resolution: "720p" } },
			poll: { intervalMs: 1 },
		});
		expect(result.video.mediaType).toBe("video/mp4");
		expect([...result.video.uint8Array]).toEqual([0, 0, 0, 24]);
		expect(
			requests.map((request) => `${request.method} ${request.url}`),
		).toEqual([
			"POST https://gateway.test/v1/videos",
			"GET https://gateway.test/v1/videos/video_1",
			"GET https://gateway.test/v1/videos/video_1",
			"GET https://gateway.test/v1/videos/video_1/content",
		]);
		expect(requests[0]?.body).toEqual({
			model: "video-default",
			prompt: "a mountain at sunset",
			duration: 8,
			aspect_ratio: "16:9",
			resolution: "720p",
		});
		expect(requests[3]?.headers.get("authorization")).toBe("Bearer sk-test");
	});

	test("a failed video job rejects with the gateway's reason", async () => {
		const job = {
			id: "video_2",
			object: "video",
			model: "video-default",
			created_at: 1_760_000_000,
		};
		const { provider } = mockGateway([
			json({ ...job, status: "queued" }),
			json({
				...job,
				status: "failed",
				error: { code: "moderation", message: "Blocked by moderation" },
			}),
		]);
		await expect(
			generateVideo({
				model: provider.video("video-default"),
				prompt: "something",
				poll: { intervalMs: 1 },
			}),
		).rejects.toThrow("Blocked by moderation");
	});
});
