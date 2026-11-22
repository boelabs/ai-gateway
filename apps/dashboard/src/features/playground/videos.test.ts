import assert from "node:assert/strict";
import type { FetchLike } from "./api";
import { test } from "node:test";

import {
	type VideoReference,
	MAX_REFERENCE_BYTES,
	type VideoSettings,
	referenceRejection,
	fitVideoSettings,
	videoContentUrl,
	referenceTypes,
	type VideoJob,
	videoChoices,
	taskConflict,
	createVideo,
	pollVideo,
	videoBody,
	delay,
} from "./videos";

const settings: VideoSettings = {
	task: "image_to_video",
	seconds: 8,
	aspectRatio: "16:9",
	resolution: "1080p",
	seed: 7,
	quality: "high",
	generateAudio: true,
};

function reference(
	role: VideoReference["role"],
	mediaType = "image/png",
): VideoReference {
	return {
		id: `${role}-${mediaType}`,
		filename: `${role}.bin`,
		mediaType,
		url: `data:${mediaType};base64,AAAA`,
		role,
	};
}

/** A job as the gateway would answer with it. */
function job(status: VideoJob["status"], progress?: number): VideoJob {
	return { id: "video_1", status, ...(progress ? { progress } : {}) };
}

test("a parameter nobody chose is not sent at all", () => {
	assert.deepEqual(videoBody("sora", "a fox in snow", {}), {
		model: "sora",
		prompt: "a fox in snow",
	});
});

test("chosen parameters are sent under the names the endpoint uses", () => {
	assert.deepEqual(videoBody("sora", "a fox", settings), {
		model: "sora",
		prompt: "a fox",
		task: "image_to_video",
		seconds: 8,
		aspect_ratio: "16:9",
		resolution: "1080p",
		seed: 7,
		quality: "high",
		generate_audio: true,
	});
});

test("silence is a choice, and is sent as one", () => {
	assert.equal(
		videoBody("sora", "a fox", { generateAudio: false }).generate_audio,
		false,
	);
	assert.equal(
		Object.hasOwn(videoBody("sora", "a fox", {}), "generate_audio"),
		false,
	);
});

test("what an attachment is for decides which field carries it", () => {
	const body = videoBody("sora", "a fox", {}, [
		reference("reference"),
		reference("reference", "video/mp4"),
		reference("first_frame"),
		reference("last_frame"),
	]);
	assert.deepEqual(body.input_references, [
		{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
		{ type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
	]);
	assert.deepEqual(body.frame_images, [
		{
			type: "image_url",
			image_url: { url: "data:image/png;base64,AAAA" },
			frame_type: "first_frame",
		},
		{
			type: "image_url",
			image_url: { url: "data:image/png;base64,AAAA" },
			frame_type: "last_frame",
		},
	]);
});

test("a run with no attachments carries neither collection", () => {
	const body = videoBody("sora", "a fox", {}, []);
	assert.equal(Object.hasOwn(body, "input_references"), false);
	assert.equal(Object.hasOwn(body, "frame_images"), false);
});

test("the combinations the gateway refuses are refused here first", () => {
	assert.equal(taskConflict(undefined, []), undefined);
	assert.equal(taskConflict("text_to_video", []), undefined);
	assert.match(
		taskConflict("text_to_video", [reference("reference")]) ?? "",
		/cannot be combined/u,
	);
	assert.match(
		taskConflict(undefined, [reference("last_frame")]) ?? "",
		/requires a first frame/u,
	);
	assert.match(
		taskConflict("image_to_video", [reference("reference", "video/mp4")]) ?? "",
		/image attachments/u,
	);
	assert.equal(
		taskConflict("image_to_video", [reference("reference")]),
		undefined,
	);
	assert.equal(
		taskConflict("image_to_video", [reference("first_frame")]),
		undefined,
	);
	assert.match(taskConflict("extend", []) ?? "", /exactly one video/u);
	assert.equal(
		taskConflict("extend", [reference("reference", "video/mp4")]),
		undefined,
	);
	assert.match(
		taskConflict("reference_to_video", [reference("first_frame")]) ?? "",
		/cannot use frames/u,
	);
});

test("a file is turned away before it is read into memory", () => {
	const big = new File(["x"], "clip.mp4", { type: "video/mp4" });
	Object.defineProperty(big, "size", { value: MAX_REFERENCE_BYTES + 1 });
	assert.match(referenceRejection(big) ?? "", /limited to/u);
	assert.match(
		referenceRejection(new File(["x"], "notes.txt", { type: "text/plain" })) ??
			"",
		/cannot be used as a reference/u,
	);
	assert.match(
		referenceRejection(new File([], "empty.png", { type: "image/png" })) ?? "",
		/empty/u,
	);
	assert.equal(
		referenceRejection(new File(["x"], "a.png", { type: "image/png" })),
		undefined,
	);
});

test("the video is served through this app's relay, with the id escaped", () => {
	assert.equal(
		videoContentUrl("video_a/b"),
		"/api/v1/videos/video_a%2Fb/content?variant=video",
	);
});

test("a job that is already finished is not polled at all", async () => {
	let calls = 0;
	const stub: FetchLike = async () => {
		calls++;
		return new Response("{}", {
			headers: { "content-type": "application/json" },
		});
	};
	const final = await pollVideo(job("completed"), { fetch: stub });
	assert.equal(final.status, "completed");
	assert.equal(calls, 0);
});

test("a job is watched to completion, reporting progress as it arrives", async () => {
	const answers = [
		job("in_progress", 40),
		job("in_progress", 80),
		job("completed", 100),
	];
	let call = 0;
	const stub: FetchLike = async (input) => {
		assert.equal(String(input), "/api/v1/videos/video_1");
		const answer = answers[call++];
		return Response.json(answer);
	};
	const waits: number[] = [];
	const seen: number[] = [];
	const final = await pollVideo(job("queued"), {
		fetch: stub,
		csrf: () => undefined,
		onUpdate: (next) => seen.push(next.progress ?? 0),
		sleep: async (ms) => {
			waits.push(ms);
		},
	});
	assert.equal(final.status, "completed");
	assert.deepEqual(seen, [40, 80, 100]);
	// The interval backs off rather than hammering a job that takes minutes.
	assert.deepEqual(waits, [1500, 1950, 2535]);
});

test("the interval stops growing at its ceiling", async () => {
	const stub: FetchLike = async () => Response.json(job("in_progress"));
	const waits: number[] = [];
	await assert.rejects(
		pollVideo(job("queued"), {
			fetch: stub,
			intervalMs: 8000,
			maxIntervalMs: 10_000,
			// The clock runs out on the fourth look, which is what ends this loop.
			now: (() => {
				let value = 0;
				return () => {
					value += 1000;
					return value;
				};
			})(),
			timeoutMs: 3000,
			sleep: async (ms) => {
				waits.push(ms);
			},
		}),
		/still being generated/u,
	);
	assert.deepEqual(waits, [8000, 10_000]);
});

test("a failed job ends the watch rather than throwing", async () => {
	const stub: FetchLike = async () =>
		Response.json({
			id: "video_1",
			status: "failed",
			error: { message: "The provider rejected the prompt." },
		});
	const final = await pollVideo(job("queued"), {
		fetch: stub,
		sleep: async () => {
			/* intentionally empty */
		},
	});
	assert.equal(final.status, "failed");
	assert.equal(final.error?.message, "The provider rejected the prompt.");
});

test("stopping a watch leaves no timer behind", async () => {
	const controller = new AbortController();
	const waiting = delay(60_000, controller.signal);
	controller.abort();
	await assert.rejects(waiting, (error: Error) => error.name === "AbortError");
	// An already aborted signal is refused without arming anything at all.
	await assert.rejects(
		delay(60_000, controller.signal),
		(error: Error) => error.name === "AbortError",
	);
});

test("the gateway's own message survives a failure, instead of a bare status", async () => {
	const stub: FetchLike = async () =>
		new Response(
			JSON.stringify({ error: { message: "duration is not supported" } }),
			{ status: 400, headers: { "content-type": "application/json" } },
		);
	await assert.rejects(
		createVideo(
			{ model: "m", prompt: "a fox", settings: {}, references: [] },
			{ fetch: stub, csrf: () => undefined },
		),
		/duration is not supported/u,
	);
});

const omni = {
	tasks: ["text_to_video", "edit", "extend"],
	durations: [3, 5, 10],
	sizes: [
		{ size: "640x360", aspectRatio: "16:9", resolution: "360p" },
		{ size: "360x640", aspectRatio: "9:16", resolution: "360p" },
		{ size: "1280x720", aspectRatio: "16:9", resolution: "720p" },
	],
	qualities: [],
	seed: false,
	generateAudio: false,
	references: { image: true, video: true, frameImages: false },
};

test("the settings offer only what the model accepts, narrowed by what is chosen", () => {
	const choices = videoChoices(omni);
	assert.deepEqual(choices.tasks, ["text_to_video", "edit", "extend"]);
	assert.deepEqual(choices.durations, [3, 5, 10]);
	assert.deepEqual(choices.aspectRatios, ["16:9", "9:16"]);
	assert.deepEqual(choices.resolutions, ["360p", "720p"]);
	assert.deepEqual(choices.sizes, ["640x360", "360x640", "1280x720"]);
	assert.equal(choices.seed, false);
	assert.equal(choices.generateAudio, false);
	assert.equal(choices.proportions, true);
	assert.deepEqual(videoChoices(omni, { aspectRatio: "9:16" }).resolutions, [
		"360p",
	]);
	assert.deepEqual(videoChoices(omni, { resolution: "720P" }).aspectRatios, [
		"16:9",
	]);
});

test("a model that takes exact sizes only offers no proportion", () => {
	const choices = videoChoices({
		...omni,
		sizes: [{ size: "1280x720" }, { size: "720x1280" }],
	});
	assert.equal(choices.proportions, false);
	assert.deepEqual(choices.sizes, ["1280x720", "720x1280"]);
});

test("without the model's options every value is offered and lengths are typed freely", () => {
	const choices = videoChoices(undefined);
	assert.ok(choices.resolutions.includes("4K"));
	assert.equal(choices.durations, undefined);
	assert.equal(choices.sizes, undefined);
	assert.equal(choices.dimensions, true);
});

test("switching models drops the settings the new model would refuse", () => {
	const fitted = fitVideoSettings(
		{
			task: "image_to_video",
			seconds: 8,
			aspectRatio: "9:16",
			resolution: "4K",
			seed: 1,
			generateAudio: true,
			quality: "high",
		},
		omni,
	);
	assert.deepEqual(fitted, { aspectRatio: "9:16" });
	const kept: VideoSettings = { task: "edit", resolution: "720p" };
	assert.equal(fitVideoSettings(kept, omni), kept);
	assert.equal(fitVideoSettings(kept, undefined), kept);
});

test("the file picker offers only the attachments the model takes", () => {
	assert.deepEqual(
		referenceTypes({
			...omni,
			references: { image: false, video: true, frameImages: false },
		}),
		["video/mp4", "video/webm"],
	);
	assert.deepEqual(
		referenceTypes({
			...omni,
			references: { image: false, video: false, frameImages: true },
		}),
		["image/png", "image/jpeg", "image/webp"],
	);
	assert.equal(referenceTypes(undefined).length, 5);
});
