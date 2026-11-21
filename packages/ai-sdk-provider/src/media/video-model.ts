import { compact, isRecord, toJSONObject } from "../shared/json.ts";
import { failedResponseHandler } from "../shared/errors.ts";
import { z } from "zod/v4";

import type {
	Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
	Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
	Experimental_VideoModelV4CallOptions as VideoModelV4CallOptions,
	Experimental_VideoModelV4File as VideoModelV4File,
	Experimental_VideoModelV4 as VideoModelV4,
	SharedV4Warning,
	JSONValue,
} from "@ai-sdk/provider";

import {
	createBinaryResponseHandler,
	createJsonResponseHandler,
	convertToBase64,
	postJsonToApi,
	getFromApi,
	zodSchema,
} from "@ai-sdk/provider-utils";

import {
	gatewayOptionsShape,
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
} from "../shared/gateway-options.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

const ASPECT_RATIOS = [
	"16:9",
	"9:16",
	"1:1",
	"4:3",
	"3:4",
	"3:2",
	"2:3",
	"21:9",
	"9:21",
] as const;

export const videoOptionsSchema = z.object({
	...gatewayOptionsShape,
	/** Workflow, when the inputs alone do not say it: `edit` and `extend` need it. */
	task: z
		.enum([
			"text_to_video",
			"image_to_video",
			"reference_to_video",
			"edit",
			"extend",
		])
		.optional(),
	/**
	 * Resolution tier (`360p`, `480p`, `720p`, `1080p`, `1K`, `2K`, `4K`), used with `aspectRatio`.
	 * The AI SDK's `resolution` (`WIDTHxHEIGHT`) is the exact-size alternative.
	 */
	resolution: z
		.enum(["360p", "480p", "720p", "1080p", "1K", "2K", "4K"])
		.optional(),
	/** Quality on the gateway's ladder (`auto`, `low`, `medium`, `high`, `xhigh`, `max`). */
	quality: z.string().optional(),
	/** End-user attribution, kept by the gateway and never sent upstream. */
	user: z.string().optional(),
});

export type BoelabsGatewayVideoOptions = z.input<typeof videoOptionsSchema>;

const videoSchema = z
	.object({
		id: z.string(),
		status: z.string(),
		model: z.string().nullish(),
		progress: z.number().nullish(),
		seconds: z.union([z.string(), z.number()]).nullish(),
		size: z.string().nullish(),
		quality: z.string().nullish(),
		created_at: z.number().nullish(),
		completed_at: z.number().nullish(),
		expires_at: z.number().nullish(),
		error: z
			.object({ code: z.string().nullish(), message: z.string().nullish() })
			.loose()
			.nullish(),
	})
	.loose();

type GatewayVideo = z.infer<typeof videoSchema>;
const videoResponseSchema = zodSchema(videoSchema);

/** `data:` URLs and HTTPS URLs are what the gateway accepts for every reference. */
function referenceUrl(file: VideoModelV4File): string {
	if (file.type === "url") {
		return file.url;
	}
	return `data:${file.mediaType};base64,${convertToBase64(file.data)}`;
}

function referenceKind(file: VideoModelV4File): "image" | "video" | "audio" {
	const type = file.mediaType?.split("/")[0];
	return type === "video" || type === "audio" ? type : "image";
}

function videoIdOf(operation: JSONValue): string {
	if (isRecord(operation) && typeof operation.videoId === "string") {
		return operation.videoId;
	}
	throw new Error("Not a Boelabs AI Gateway video operation.");
}

function videoMetadata(video: GatewayVideo) {
	return toJSONObject(
		compact({
			videoId: video.id,
			status: video.status,
			progress: video.progress ?? undefined,
			seconds: video.seconds ?? undefined,
			size: video.size ?? undefined,
			quality: video.quality ?? undefined,
			expiresAt: video.expires_at ?? undefined,
		}),
	);
}

/**
 * Video model on the gateway's `/v1/videos`: `doStart` submits a job and `doStatus` polls it;
 * the AI SDK drives the loop. A completed job's bytes are downloaded here, with the gateway
 * credentials, because the content URL is not public.
 */
export class BoelabsGatewayVideoModel implements VideoModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;
	/** The gateway makes one video per job. */
	readonly maxVideosPerCall = 1;

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doStart(
		options: VideoModelV4CallOptions & { webhookUrl?: string },
	): Promise<VideoModelV4OperationStartResult> {
		const warnings: SharedV4Warning[] = [];
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				videoOptionsSchema,
			)) ?? {};

		if (options.n > 1) {
			warnings.push({
				type: "unsupported",
				feature: "n",
				details: "One video per job; start several jobs instead.",
			});
		}
		for (const [feature, value] of [
			["fps", options.fps],
			["webhookUrl", options.webhookUrl],
		] as const) {
			if (value !== undefined) {
				warnings.push({ type: "unsupported", feature });
			}
		}

		const requestedRatio = options.aspectRatio;
		const aspectRatio = (ASPECT_RATIOS as readonly string[]).includes(
			requestedRatio ?? "",
		)
			? requestedRatio
			: undefined;
		if (requestedRatio !== undefined && aspectRatio === undefined) {
			warnings.push({
				type: "unsupported",
				feature: "aspectRatio",
				details: `Use one of ${ASPECT_RATIOS.join(", ")}.`,
			});
		}
		// The gateway takes either an exact size or aspect ratio + resolution tier, not both.
		const size = options.resolution;
		if (
			size !== undefined &&
			(aspectRatio !== undefined || opts.resolution !== undefined)
		) {
			warnings.push({
				type: "other",
				message:
					"`resolution` (WIDTHxHEIGHT) is an exact size; aspectRatio and the resolution tier were not sent.",
			});
		}

		const references = [
			...(options.image === undefined ? [] : [options.image]),
			...(options.inputReferences ?? []),
		].map((file) => {
			const kind = referenceKind(file);
			return {
				type: `${kind}_url`,
				[`${kind}_url`]: { url: referenceUrl(file) },
			};
		});
		const frames = (options.frameImages ?? []).map((frame) => ({
			type: "image_url",
			image_url: { url: referenceUrl(frame.image) },
			frame_type: frame.frameType,
		}));

		const body = compact({
			model: this.modelId,
			prompt: options.prompt,
			task: opts.task,
			duration: options.duration,
			...(size === undefined
				? { aspect_ratio: aspectRatio, resolution: opts.resolution }
				: { size }),
			seed: options.seed,
			generate_audio: options.generateAudio,
			input_references: references.length > 0 ? references : undefined,
			frame_images: frames.length > 0 ? frames : undefined,
			quality: opts.quality,
			user: opts.user,
			extra_body: opts.extraBody,
		});

		const { value, responseHeaders } = await postJsonToApi({
			url: apiUrl(this.config, "/videos"),
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			body,
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(videoResponseSchema),
			...transport(this.config, options.abortSignal),
		});

		return {
			operation: { videoId: value.id },
			warnings,
			providerMetadata: {
				[this.config.providerMetadataName]: {
					...videoMetadata(value),
					...gatewayMetadata(responseHeaders),
				},
			},
			response: {
				timestamp:
					value.created_at == null
						? new Date()
						: new Date(value.created_at * 1000),
				modelId: value.model ?? this.modelId,
				headers: responseHeaders,
			},
		};
	}

	async doStatus(options: {
		operation: JSONValue;
		abortSignal?: AbortSignal;
		headers?: Record<string, string | undefined>;
	}): Promise<VideoModelV4OperationStatusResult> {
		const videoId = videoIdOf(options.operation);
		const headers = requestHeaders(this.config, options.headers);
		const path = `/videos/${encodeURIComponent(videoId)}`;
		const { value, responseHeaders } = await getFromApi({
			url: apiUrl(this.config, path),
			headers,
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(videoResponseSchema),
			validateUrl: false,
			...transport(this.config, options.abortSignal),
		});
		const response = {
			timestamp: new Date(),
			modelId: value.model ?? this.modelId,
			headers: responseHeaders,
		};
		const providerMetadata = {
			[this.config.providerMetadataName]: videoMetadata(value),
		};

		if (value.status === "failed") {
			return {
				status: "error",
				error: value.error?.message ?? "The video generation failed.",
				providerMetadata,
				response,
			};
		}
		if (value.status !== "completed") {
			return { status: "pending", providerMetadata, response };
		}

		const { value: bytes, responseHeaders: contentHeaders } = await getFromApi({
			url: apiUrl(this.config, `${path}/content`),
			headers,
			failedResponseHandler,
			successfulResponseHandler: createBinaryResponseHandler(),
			validateUrl: false,
			...transport(this.config, options.abortSignal),
		});
		return {
			status: "completed",
			videos: [
				{
					type: "binary",
					data: bytes,
					mediaType: contentHeaders?.["content-type"] ?? "video/mp4",
				},
			],
			warnings: [],
			providerMetadata,
			response,
		};
	}
}
