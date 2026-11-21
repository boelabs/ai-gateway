import { failedResponseHandler } from "../shared/errors.ts";
import { compact } from "../shared/json.ts";
import { z } from "zod/v4";

import {
	gatewayOptionsShape,
	gatewayMetadata,
	gatewayHeaders,
	parseOptions,
	wireModelId,
} from "../shared/gateway-options.ts";

import type {
	SpeechModelV4CallOptions,
	SpeechModelV4Result,
	SharedV4Warning,
	SpeechModelV4,
} from "@ai-sdk/provider";

import {
	type BoelabsGatewayConfig,
	requestHeaders,
	transport,
	apiUrl,
} from "../shared/config.ts";

import {
	createBinaryResponseHandler,
	postJsonToApi,
} from "@ai-sdk/provider-utils";

const FORMATS = ["mp3", "opus", "aac", "flac", "wav", "pcm"] as const;

export const speechOptionsSchema = z.object({
	...gatewayOptionsShape,
	/** A custom voice id (`{ "id": … }` on the wire); takes precedence over `voice`. */
	voiceId: z.string().optional(),
});

export type BoelabsGatewaySpeechOptions = z.input<typeof speechOptionsSchema>;

/** Speech model on the gateway's `/v1/audio/speech`. */
export class BoelabsGatewaySpeechModel implements SpeechModelV4 {
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
		options: SpeechModelV4CallOptions,
	): Promise<SpeechModelV4Result> {
		const warnings: SharedV4Warning[] = [];
		const opts =
			(await parseOptions(
				options.providerOptions,
				this.config.providerOptionsNames,
				speechOptionsSchema,
			)) ?? {};

		let format: string | undefined;
		if (options.outputFormat !== undefined) {
			if ((FORMATS as readonly string[]).includes(options.outputFormat)) {
				format = options.outputFormat;
			} else {
				warnings.push({
					type: "unsupported",
					feature: "outputFormat",
					details: `Use one of ${FORMATS.join(", ")}; the gateway does not transcode.`,
				});
			}
		}
		if (options.language !== undefined) {
			warnings.push({
				type: "unsupported",
				feature: "language",
				details: "The model speaks the language of the text.",
			});
		}

		const body = compact({
			model: wireModelId(this.modelId, opts.serviceMode),
			input: options.text,
			voice: opts.voiceId === undefined ? options.voice : { id: opts.voiceId },
			instructions: options.instructions,
			response_format: format,
			speed: options.speed,
			extra_body: opts.extraBody,
		});
		const { value, responseHeaders } = await postJsonToApi({
			url: apiUrl(this.config, "/audio/speech"),
			headers: requestHeaders(
				this.config,
				gatewayHeaders(opts),
				options.headers,
			),
			body,
			failedResponseHandler,
			successfulResponseHandler: createBinaryResponseHandler(),
			...transport(this.config, options.abortSignal),
		});

		return {
			audio: value,
			warnings,
			request: { body: JSON.stringify(body) },
			response: compact({
				timestamp: new Date(),
				modelId: this.modelId,
				headers: responseHeaders,
			}),
			providerMetadata: {
				[this.config.providerMetadataName]: {
					...(responseHeaders?.["content-type"] === undefined
						? {}
						: { mediaType: responseHeaders["content-type"] }),
					...gatewayMetadata(responseHeaders),
				},
			},
		};
	}
}
