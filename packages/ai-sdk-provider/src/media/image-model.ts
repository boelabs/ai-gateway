import { failedResponseHandler } from "../shared/errors.ts";
import { compact, toJSONValue } from "../shared/json.ts";
import { z } from "zod/v4";

import {
	convertBase64ToUint8Array,
	createJsonResponseHandler,
	postFormDataToApi,
	postJsonToApi,
	downloadBlob,
	zodSchema,
} from "@ai-sdk/provider-utils";

import type {
	ImageModelV4CallOptions,
	ImageModelV4Result,
	ImageModelV4File,
	SharedV4Warning,
	ImageModelV4,
} from "@ai-sdk/provider";

import {
	gatewayOptionsShape,
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
	wireModelId,
} from "../shared/gateway-options.ts";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

export const imageOptionsSchema = z.object({
	...gatewayOptionsShape,
	/**
	 * Quality on the gateway's ladder (`auto`, `low`, `medium`, `high`, `xhigh`, `max`). A rung the
	 * model lacks snaps to the nearest one it has; on Gemini image models it sets thinking.
	 */
	quality: z.string().optional(),
	/** `transparent`, `opaque` or `auto`. */
	background: z.enum(["transparent", "opaque", "auto"]).optional(),
	/** `png`, `jpeg` or `webp`. */
	outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
	/** 0–100, for `jpeg` and `webp`. */
	outputCompression: z.number().int().min(0).max(100).optional(),
	/** Moderation strictness (`auto` or `low`). */
	moderation: z.string().optional(),
	/** Fidelity to the input images on edits (`low` or `high`). */
	inputFidelity: z.string().optional(),
	/** Style on models that take one (`vivid`, `natural`). */
	style: z.string().optional(),
	/** End-user identifier. */
	user: z.string().optional(),
});

export type BoelabsGatewayImageOptions = z.input<typeof imageOptionsSchema>;

const responseSchema = zodSchema(
	z
		.object({
			created: z.number().nullish(),
			data: z.array(
				z
					.object({
						b64_json: z.string(),
						revised_prompt: z.string().nullish(),
					})
					.loose(),
			),
			size: z.string().nullish(),
			quality: z.string().nullish(),
			output_format: z.string().nullish(),
			background: z.string().nullish(),
			usage: z
				.object({
					input_tokens: z.number().nullish(),
					output_tokens: z.number().nullish(),
					total_tokens: z.number().nullish(),
				})
				.loose()
				.nullish(),
		})
		.loose(),
);

function extensionOf(mediaType: string): string {
	switch (mediaType) {
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		default:
			return "png";
	}
}

/** Image model on the gateway's `/v1/images/generations` and `/v1/images/edits`. */
export class BoelabsGatewayImageModel implements ImageModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;
	/** Undeclared here; a model's profile may cap it (`max_n`) and the gateway enforces that. */
	readonly maxImagesPerCall = undefined;
	readonly supportsFileInputs = true;
	readonly supportsMaskInputs = true;

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doGenerate(
		options: ImageModelV4CallOptions,
	): Promise<ImageModelV4Result> {
		const warnings: SharedV4Warning[] = [];
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				imageOptionsSchema,
			)) ?? {};
		if (options.aspectRatio !== undefined) {
			warnings.push({
				type: "unsupported",
				feature: "aspectRatio",
				details:
					"Image models take a `size`; see the model's `image_capabilities.sizes`.",
			});
		}
		if (options.seed !== undefined) {
			warnings.push({ type: "unsupported", feature: "seed" });
		}

		const fields = compact({
			model: wireModelId(this.modelId, opts.serviceMode),
			prompt: options.prompt,
			n: options.n,
			size: options.size,
			quality: opts.quality,
			background: opts.background,
			output_format: opts.outputFormat,
			output_compression: opts.outputCompression,
			moderation: opts.moderation,
			input_fidelity: opts.inputFidelity,
			style: opts.style,
			user: opts.user,
		});
		const common = {
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(responseSchema),
			...transport(this.config, options.abortSignal),
		};

		const files = options.files ?? [];
		const { value, responseHeaders } =
			files.length === 0
				? await postJsonToApi({
						...common,
						url: apiUrl(this.config, "/images/generations"),
						body: compact({ ...fields, extra_body: opts.extraBody }),
					})
				: await postFormDataToApi({
						...common,
						url: apiUrl(this.config, "/images/edits"),
						formData: await this.editForm(
							fields,
							opts.extraBody,
							files,
							options,
						),
					});

		// The AI SDK keeps only `images` when it aggregates calls, so the facts of the call ride on
		// each image's entry too.
		const facts = compact({
			size: value.size ?? undefined,
			quality: value.quality ?? undefined,
			outputFormat: value.output_format ?? undefined,
			background: value.background ?? undefined,
			...gatewayMetadata(responseHeaders),
		});
		return {
			images: value.data.map((image) => image.b64_json),
			warnings,
			providerMetadata: {
				[this.config.providerMetadataName]: {
					images: value.data.map((image) =>
						toJSONValue(
							compact({
								revisedPrompt: image.revised_prompt ?? undefined,
								...facts,
							}),
						),
					),
					...facts,
				},
			},
			response: {
				timestamp:
					value.created == null ? new Date() : new Date(value.created * 1000),
				modelId: this.modelId,
				headers: responseHeaders,
			},
			...(value.usage == null
				? {}
				: {
						usage: {
							inputTokens: value.usage.input_tokens ?? undefined,
							outputTokens: value.usage.output_tokens ?? undefined,
							totalTokens: value.usage.total_tokens ?? undefined,
						},
					}),
		};
	}

	private async fileBlob(
		file: ImageModelV4File,
		abortSignal: AbortSignal | undefined,
	): Promise<Blob> {
		if (file.type === "url") {
			// Edits are multipart on the gateway, so a URL input is fetched here first.
			return await downloadBlob(file.url, transport(this.config, abortSignal));
		}
		const bytes =
			typeof file.data === "string"
				? convertBase64ToUint8Array(file.data)
				: file.data;
		return new Blob([new Uint8Array(bytes)], { type: file.mediaType });
	}

	private async editForm(
		fields: Record<string, unknown>,
		extraBody: Record<string, unknown> | undefined,
		files: ImageModelV4File[],
		options: ImageModelV4CallOptions,
	): Promise<FormData> {
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			form.append(key, String(value));
		}
		if (extraBody !== undefined) {
			// A multipart body has no nested fields; the gateway parses `extra_body` as JSON.
			form.append("extra_body", JSON.stringify(extraBody));
		}
		const field = files.length > 1 ? "image[]" : "image";
		for (const [index, file] of files.entries()) {
			const blob = await this.fileBlob(file, options.abortSignal);
			form.append(field, blob, `image-${index}.${extensionOf(blob.type)}`);
		}
		if (options.mask !== undefined) {
			const blob = await this.fileBlob(options.mask, options.abortSignal);
			form.append("mask", blob, `mask.${extensionOf(blob.type)}`);
		}
		return form;
	}
}
