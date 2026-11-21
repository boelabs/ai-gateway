import { failedResponseHandler } from "../shared/errors.ts";
import { compact, toJSONObject } from "../shared/json.ts";
import { z } from "zod/v4";

import {
	convertBase64ToUint8Array,
	createJsonResponseHandler,
	mediaTypeToExtension,
	postFormDataToApi,
	zodSchema,
} from "@ai-sdk/provider-utils";

import type {
	TranscriptionModelV4CallOptions,
	TranscriptionModelV4Result,
	TranscriptionModelV4,
	SharedV4Warning,
} from "@ai-sdk/provider";

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

export const transcriptionOptionsSchema = z.object({
	...gatewayOptionsShape,
	/** Language of the audio (ISO-639-1 or BCP-47, e.g. `es` or `es-419`). */
	language: z.string().optional(),
	/** Possible languages of the audio; send this or `language`, not both. */
	languages: z.array(z.string()).optional(),
	/** Names and domain terms to recognize. */
	keywords: z.array(z.string()).optional(),
	/** Free-form context or a previous segment's transcript. */
	prompt: z.string().optional(),
	/** Sampling temperature (0–1). */
	temperature: z.number().min(0).max(1).optional(),
	/**
	 * `json` (default), `verbose_json` (segments, words, duration, language) or `diarized_json`
	 * (segments with speakers). Requesting timestamps switches the default to `verbose_json`.
	 */
	responseFormat: z.enum(["json", "verbose_json", "diarized_json"]).optional(),
	/** Extra `include` values, e.g. `logprobs`. */
	include: z.array(z.string()).optional(),
	/** `smart` drops fillers and formats numbers on models that support it. */
	transcriptionMode: z.enum(["verbatim", "smart"]).optional(),
});

export type BoelabsGatewayTranscriptionOptions = z.input<
	typeof transcriptionOptionsSchema
>;

const timedSchema = z
	.object({
		start: z.number(),
		end: z.number(),
		text: z.string().nullish(),
		word: z.string().nullish(),
		speaker: z.string().nullish(),
	})
	.loose();

const responseSchema = zodSchema(
	z
		.object({
			text: z.string(),
			language: z.string().nullish(),
			languages: z.array(z.object({ code: z.string() }).loose()).nullish(),
			duration: z.number().nullish(),
			segments: z.array(timedSchema).nullish(),
			words: z.array(timedSchema).nullish(),
			usage: z.record(z.string(), z.unknown()).nullish(),
		})
		.loose(),
);

/** Transcription model on the gateway's `/v1/audio/transcriptions`. */
export class BoelabsGatewayTranscriptionModel implements TranscriptionModelV4 {
	readonly specificationVersion = "v4";
	readonly modelId: string;

	private readonly config: BoelabsGatewayConfig;

	constructor(modelId: string, config: BoelabsGatewayConfig) {
		this.modelId = modelId;
		this.config = config;
	}

	get provider(): string {
		return this.config.provider;
	}

	async doGenerate(
		options: TranscriptionModelV4CallOptions,
	): Promise<TranscriptionModelV4Result> {
		const warnings: SharedV4Warning[] = [];
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				transcriptionOptionsSchema,
			)) ?? {};
		const granularities = options.timestampGranularities ?? [];
		const responseFormat =
			opts.responseFormat ??
			(granularities.length > 0 ? "verbose_json" : "json");
		if (granularities.length > 0 && responseFormat !== "verbose_json") {
			warnings.push({
				type: "unsupported",
				feature: "timestampGranularities",
				details: 'Timestamps need `responseFormat: "verbose_json"`.',
			});
		}

		const form = new FormData();
		const bytes =
			typeof options.audio === "string"
				? convertBase64ToUint8Array(options.audio)
				: options.audio;
		form.append(
			"file",
			new Blob([new Uint8Array(bytes)], { type: options.mediaType }),
			`audio.${mediaTypeToExtension(options.mediaType)}`,
		);
		const fields = compact({
			model: this.modelId,
			language: opts.language,
			prompt: opts.prompt,
			temperature: opts.temperature,
			response_format: responseFormat,
			transcription_mode: opts.transcriptionMode,
		});
		for (const [key, value] of Object.entries(fields)) {
			form.append(key, String(value));
		}
		const lists: Record<string, string[] | undefined> = {
			"languages[]": opts.languages,
			"keywords[]": opts.keywords,
			"include[]": opts.include,
			"timestamp_granularities[]":
				responseFormat === "verbose_json" ? granularities : undefined,
		};
		for (const [key, values] of Object.entries(lists)) {
			for (const value of values ?? []) {
				form.append(key, value);
			}
		}

		const { value, rawValue, responseHeaders } = await postFormDataToApi({
			url: apiUrl(this.config, "/audio/transcriptions"),
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			formData: form,
			failedResponseHandler,
			successfulResponseHandler: createJsonResponseHandler(responseSchema),
			...transport(this.config, options.abortSignal),
		});

		const words = (value.words ?? []).map((word) => ({
			text: word.word ?? word.text ?? "",
			startSecond: word.start,
			endSecond: word.end,
		}));
		const speakers = (value.segments ?? []).some(
			(segment) => segment.speaker != null,
		);

		return {
			text: value.text,
			segments: (value.segments ?? []).map((segment) => ({
				text: segment.text ?? "",
				startSecond: segment.start,
				endSecond: segment.end,
			})),
			...(words.length > 0 ? { words } : {}),
			language: value.language ?? value.languages?.[0]?.code ?? undefined,
			durationInSeconds: value.duration ?? undefined,
			warnings,
			...(value.usage == null ? {} : { usage: toJSONObject(value.usage) }),
			response: compact({
				timestamp: new Date(),
				modelId: this.modelId,
				headers: responseHeaders,
				body: rawValue,
			}),
			providerMetadata: {
				[this.config.providerMetadataName]: {
					...(speakers
						? {
								speakerSegments: (value.segments ?? []).map((segment) =>
									toJSONObject({
										speaker: segment.speaker ?? null,
										text: segment.text ?? "",
										startSecond: segment.start,
										endSecond: segment.end,
									}),
								),
							}
						: {}),
					...(value.languages == null
						? {}
						: { languages: value.languages.map((entry) => entry.code) }),
					...gatewayMetadata(responseHeaders),
				},
			},
		};
	}
}
