import { SERVICE_MODES, type ServiceMode } from "./api";
import { type Capability, CAPABILITIES } from "./capabilities.ts";
import type { PublicEndpoint } from "./api.ts";
import { z } from "zod";

export const REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ParameterConstraint {
	min?: number;
	max?: number;
	values?: Array<string | number | boolean>;
}

export interface PlaygroundCapabilities {
	supportedParameters: string[];
	inputModalities: string[];
	parameterConstraints: Record<string, ParameterConstraint>;
	reasoningEfforts: ReasoningEffort[];
	maxOutputTokens?: number;
}

export interface PlaygroundModel extends PlaygroundCapabilities {
	id: string;
	/** The `model:mode` service modes the gateway will route for this model; empty for none. */
	serviceModes: ServiceMode[];
	/**
	 * What this model can be asked to do here — the same model may offer several, and it is listed
	 * under each. Only capabilities the playground implements appear; see `capabilities.ts`.
	 */
	capabilities: Capability[];
	/** The catalog's own operation ids, for the few choices a capability alone cannot answer. */
	operations: string[];
	/** The public contracts text generation is available under. Empty for a model that has none. */
	endpoints: PublicEndpoint[];
	acceptsImages: boolean;
	/** What video generation accepts; absent when the gateway does not say (an older one). */
	video?: VideoOptions;
	/** What image generation and editing accept; absent when the gateway does not say. */
	image?: ImageOptions;
	/** What embeddings accept; absent when the gateway does not say. */
	embedding?: EmbeddingOptions;
	/** What transcription accepts; absent when the gateway does not say. */
	transcription?: TranscriptionOptions;
}

export interface EmbeddingOptions {
	/** Present only when the model can shorten its vectors. */
	dimensions?: { min: number; max?: number };
	encodingFormats: string[];
}

export interface TranscriptionOptions {
	responseFormats: string[];
	/** Empty when timestamps are refused; they also need `verbose_json`. */
	timestampGranularities: string[];
}

/** The gateway's `image_capabilities` for one operation; `auto` size and quality always go. */
export interface ImageOperationOptions {
	sizes: string[];
	arbitrarySizes: boolean;
	qualities: string[];
	outputFormats: string[];
	transparentBackground: boolean;
	style: boolean;
	mask: boolean;
	maxN?: number;
	maxInputImages?: number;
}

export interface ImageOptions {
	generate?: ImageOperationOptions;
	edit?: ImageOperationOptions;
}

/** A size the model accepts, with the proportion and resolution it amounts to. */
export interface VideoSizeOption {
	size: string;
	aspectRatio?: string;
	resolution?: string;
}

/** The gateway's `video_capabilities`: only values no deployment of the model would refuse. */
export interface VideoOptions {
	tasks: string[];
	durations: number[];
	/** Absent when the model declares no size table, so any dimensions go through unchecked. */
	sizes?: VideoSizeOption[];
	qualities: string[];
	seed: boolean;
	generateAudio: boolean;
	references: {
		image: boolean;
		video: boolean;
		frameImages: boolean;
	};
}

const endpointPaths: Record<PublicEndpoint, string> = {
	"chat.completions": "/v1/chat/completions",
	responses: "/v1/responses",
	messages: "/v1/messages",
};
const endpoints = ["chat.completions", "responses", "messages"] as const;
const constraintSchema = z.object({
	min: z.number().optional(),
	max: z.number().optional(),
	values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
const imageOperationSchema = z.object({
	sizes: z.array(z.string()),
	arbitrary_sizes: z.boolean(),
	qualities: z.array(z.string()),
	output_formats: z.array(z.string()),
	transparent_background: z.boolean(),
	style: z.boolean(),
	mask: z.boolean(),
	max_n: z.number().int().positive().optional(),
	max_input_images: z.number().int().positive().optional(),
});
const publicModelsSchema = z.object({
	data: z.array(
		z.object({
			id: z.string().min(1),
			operations: z.array(
				z.object({ id: z.string(), endpoints: z.array(z.string()) }),
			),
			supported_parameters: z.array(z.string()).optional(),
			// Unknown future modes are dropped, not fatal: an older dashboard keeps working.
			service_modes: z.array(z.string()).optional(),
			architecture: z
				.object({ input_modalities: z.array(z.string()).optional() })
				.optional(),
			image_capabilities: z
				.object({
					generate: imageOperationSchema.optional(),
					edit: imageOperationSchema.optional(),
				})
				.optional(),
			embedding_capabilities: z
				.object({
					dimensions: z
						.object({
							min: z.number().int().positive(),
							max: z.number().int().positive().optional(),
						})
						.optional(),
					encoding_formats: z.array(z.string()),
				})
				.optional(),
			transcription_capabilities: z
				.object({
					response_formats: z.array(z.string()),
					timestamp_granularities: z.array(z.string()),
				})
				.optional(),
			video_capabilities: z
				.object({
					tasks: z.array(z.string()),
					durations: z.array(z.string()),
					sizes: z
						.array(
							z.object({
								size: z.string(),
								aspect_ratio: z.string().optional(),
								resolution: z.string().optional(),
							}),
						)
						.optional(),
					qualities: z.array(z.string()),
					seed: z.boolean(),
					generate_audio: z.boolean(),
					input_references: z.object({
						image: z.boolean(),
						video: z.boolean(),
						frame_images: z.boolean(),
					}),
				})
				.optional(),
			text_capabilities: z
				.object({
					contracts: z.array(z.string()),
					supported_parameters: z.array(z.string()),
					input_modalities: z.array(z.string()),
					parameter_constraints: z.record(z.string(), constraintSchema),
					reasoning_efforts: z.array(z.enum(REASONING_EFFORTS)),
					max_output_tokens: z.number().int().positive().optional(),
				})
				.optional(),
		}),
	),
});

function imageOperation(
	operation: z.infer<typeof imageOperationSchema>,
): ImageOperationOptions {
	return {
		sizes: operation.sizes,
		arbitrarySizes: operation.arbitrary_sizes,
		qualities: operation.qualities,
		outputFormats: operation.output_formats,
		transparentBackground: operation.transparent_background,
		style: operation.style,
		mask: operation.mask,
		...(operation.max_n === undefined ? {} : { maxN: operation.max_n }),
		...(operation.max_input_images === undefined
			? {}
			: { maxInputImages: operation.max_input_images }),
	};
}

function imageOptions(image: {
	generate?: z.infer<typeof imageOperationSchema> | undefined;
	edit?: z.infer<typeof imageOperationSchema> | undefined;
}): ImageOptions {
	return {
		...(image.generate ? { generate: imageOperation(image.generate) } : {}),
		...(image.edit ? { edit: imageOperation(image.edit) } : {}),
	};
}

type PublicVideoCapabilities = NonNullable<
	z.infer<typeof publicModelsSchema>["data"][number]["video_capabilities"]
>;

function videoOptions(video: PublicVideoCapabilities): VideoOptions {
	return {
		tasks: video.tasks,
		durations: video.durations
			.map(Number)
			.filter((seconds) => Number.isFinite(seconds) && seconds > 0),
		...(video.sizes
			? {
					sizes: video.sizes.map((entry) => ({
						size: entry.size,
						...(entry.aspect_ratio ? { aspectRatio: entry.aspect_ratio } : {}),
						...(entry.resolution ? { resolution: entry.resolution } : {}),
					})),
				}
			: {}),
		qualities: video.qualities,
		seed: video.seed,
		generateAudio: video.generate_audio,
		references: {
			image: video.input_references.image,
			video: video.input_references.video,
			frameImages: video.input_references.frame_images,
		},
	};
}

export function parsePublicModels(body: unknown): PlaygroundModel[] {
	return publicModelsSchema
		.parse(body)
		.data.flatMap((model): PlaygroundModel[] => {
			const text = model.operations.find(
				(operation) => operation.id === "text.generate",
			);
			const capabilities = model.text_capabilities;
			const available = endpoints.filter(
				(endpoint) =>
					text?.endpoints.includes(endpointPaths[endpoint]) &&
					(capabilities?.contracts.includes(endpoint) ?? true),
			);
			// A capability with no public endpoint left to send it through is not one this playground
			// can offer, whatever the catalog says the model supports.
			const operations = model.operations
				.filter((operation) => operation.endpoints.length > 0)
				.map((operation) => operation.id);
			const availableCapabilities = CAPABILITIES.flatMap(
				(capability): Capability[] =>
					capability.operations.some((id) => operations.includes(id)) &&
					(capability.id !== "text" || available.length > 0)
						? [capability.id]
						: [],
			);
			if (!availableCapabilities.length) {
				return [];
			}
			// Older catalogs only provide a union: do not infer safe optional controls or attachments.
			const inputModalities = capabilities?.input_modalities ?? ["text"];
			const parameterConstraints: Record<string, ParameterConstraint> = {};
			for (const [name, constraint] of Object.entries(
				capabilities?.parameter_constraints ?? {},
			)) {
				parameterConstraints[name] = {
					...(constraint.min === undefined ? {} : { min: constraint.min }),
					...(constraint.max === undefined ? {} : { max: constraint.max }),
					...(constraint.values === undefined
						? {}
						: { values: constraint.values }),
				};
			}
			return [
				{
					id: model.id,
					serviceModes: SERVICE_MODES.filter((mode) =>
						model.service_modes?.includes(mode),
					),
					capabilities: availableCapabilities,
					operations,
					endpoints: available,
					supportedParameters: capabilities?.supported_parameters ?? [],
					inputModalities,
					acceptsImages: inputModalities.includes("image"),
					parameterConstraints,
					reasoningEfforts: REASONING_EFFORTS.filter((effort) =>
						capabilities?.reasoning_efforts.includes(effort),
					),
					...(capabilities?.max_output_tokens === undefined
						? {}
						: { maxOutputTokens: capabilities.max_output_tokens }),
					...(model.video_capabilities
						? { video: videoOptions(model.video_capabilities) }
						: {}),
					...(model.image_capabilities
						? { image: imageOptions(model.image_capabilities) }
						: {}),
					...(model.embedding_capabilities
						? {
								embedding: {
									...(model.embedding_capabilities.dimensions
										? {
												dimensions: {
													min: model.embedding_capabilities.dimensions.min,
													...(model.embedding_capabilities.dimensions.max ===
													undefined
														? {}
														: {
																max: model.embedding_capabilities.dimensions
																	.max,
															}),
												},
											}
										: {}),
									encodingFormats:
										model.embedding_capabilities.encoding_formats,
								},
							}
						: {}),
					...(model.transcription_capabilities
						? {
								transcription: {
									responseFormats:
										model.transcription_capabilities.response_formats,
									timestampGranularities:
										model.transcription_capabilities.timestamp_granularities,
								},
							}
						: {}),
				},
			];
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

/** One entry per capability that has models, in the registry's order, for the picker's groups. */
export interface CapabilityGroup {
	capability: Capability;
	label: string;
	items: ModelChoice[];
}

/** A model under one of its capabilities — what the picker offers and what selecting one returns. */
export interface ModelChoice {
	key: string;
	capability: Capability;
	model: PlaygroundModel;
}

export function choiceKey(capability: Capability, modelId: string): string {
	return `${capability}:${modelId}`;
}

/**
 * The catalog arranged by capability.
 *
 * A model with several capabilities is repeated, once per group: the group it is picked from is how
 * the operator says which operation this session is about, so the two listings are genuinely
 * different choices rather than a duplicate.
 */
export function capabilityGroups(models: PlaygroundModel[]): CapabilityGroup[] {
	return CAPABILITIES.flatMap((capability): CapabilityGroup[] => {
		const items = models
			.filter((model) => model.capabilities.includes(capability.id))
			.map((model) => ({
				key: choiceKey(capability.id, model.id),
				capability: capability.id,
				model,
			}));
		return items.length
			? [{ capability: capability.id, label: capability.label, items }]
			: [];
	});
}

const endpointParameters: Record<PublicEndpoint, readonly string[]> = {
	"chat.completions": [
		"temperature",
		"top_p",
		"max_tokens",
		"presence_penalty",
		"frequency_penalty",
		"seed",
		"stop",
		"reasoning",
		"reasoning_effort",
	],
	responses: [
		"temperature",
		"top_p",
		"max_tokens",
		"presence_penalty",
		"frequency_penalty",
		"reasoning",
		"reasoning_effort",
	],
	messages: [
		"temperature",
		"top_p",
		"top_k",
		"max_tokens",
		"stop",
		"reasoning",
		"reasoning_effort",
	],
};

export function supports(
	model: PlaygroundModel,
	parameter: string,
	endpoint?: PublicEndpoint,
): boolean {
	return (
		model.supportedParameters.includes(parameter) &&
		(endpoint === undefined ||
			(model.endpoints.includes(endpoint) &&
				endpointParameters[endpoint].includes(parameter)))
	);
}

export function capabilitiesFor(
	model: PlaygroundModel,
	endpoint: PublicEndpoint,
): PlaygroundCapabilities {
	if (!model.endpoints.includes(endpoint)) {
		return {
			supportedParameters: [],
			inputModalities: [],
			parameterConstraints: {},
			reasoningEfforts: [],
		};
	}
	return {
		...model,
		supportedParameters: model.supportedParameters.filter((parameter) =>
			supports(model, parameter, endpoint),
		),
		inputModalities: model.inputModalities.filter((modality) =>
			[
				"text",
				"image",
				"pdf",
				...(endpoint === "chat.completions" ? ["audio"] : []),
			].includes(modality),
		),
	};
}

export function reasoningEffortsFor(
	model: PlaygroundModel,
	endpoint: PublicEndpoint,
): ReasoningEffort[] {
	return supports(model, "reasoning", endpoint) &&
		supports(model, "reasoning_effort", endpoint)
		? model.reasoningEfforts
		: [];
}

export const TUNABLE = [
	{
		key: "temperature",
		label: "Temperature",
		min: 0,
		max: 2,
		step: 0.05,
		fallback: 1,
	},
	{ key: "top_p", label: "Top P", min: 0, max: 1, step: 0.05, fallback: 1 },
	{ key: "top_k", label: "Top K", min: 1, max: 100, step: 1, fallback: 40 },
	{
		key: "max_tokens",
		label: "Max tokens",
		min: 1,
		max: 8192,
		step: 1,
		fallback: 1024,
	},
	{
		key: "presence_penalty",
		label: "Presence penalty",
		min: -2,
		max: 2,
		step: 0.05,
		fallback: 0,
	},
	{
		key: "frequency_penalty",
		label: "Frequency penalty",
		min: -2,
		max: 2,
		step: 0.05,
		fallback: 0,
	},
	{
		key: "seed",
		label: "Seed",
		min: 0,
		max: 2_147_483_647,
		step: 1,
		fallback: 0,
	},
] as const;
export type TunableKey = (typeof TUNABLE)[number]["key"];

export function parameterValues(
	model: PlaygroundModel,
	key: TunableKey,
): number[] {
	const constraint = model.parameterConstraints[key];
	return (
		constraint?.values?.filter(
			(value): value is number =>
				typeof value === "number" &&
				value >= (constraint.min ?? Number.NEGATIVE_INFINITY) &&
				value <= (constraint.max ?? Number.POSITIVE_INFINITY) &&
				(key !== "max_tokens" ||
					(value > 0 &&
						value <= (model.maxOutputTokens ?? Number.POSITIVE_INFINITY))),
		) ?? []
	);
}
export interface Tunable {
	key: TunableKey;
	label: string;
	min: number;
	max: number;
	step: number;
	fallback: number;
}

export function tunablesFor(
	model: PlaygroundModel,
	endpoint: PublicEndpoint,
): Tunable[] {
	return TUNABLE.flatMap((control): Tunable[] => {
		if (!supports(model, control.key, endpoint)) {
			return [];
		}
		const constraint = model.parameterConstraints[control.key];
		// Enumerations are not continuous slider ranges; omit rather than offer invalid intermediate values.
		if (constraint?.values !== undefined) {
			return [];
		}
		const min = Math.max(control.min, constraint?.min ?? control.min);
		const limit =
			control.key === "max_tokens" ? model.maxOutputTokens : undefined;
		const max = Math.min(
			constraint?.max ?? limit ?? control.max,
			limit ?? Number.POSITIVE_INFINITY,
		);
		if (min > max) {
			return [];
		}
		return [
			{
				...control,
				min,
				max,
				fallback: Math.min(max, Math.max(min, control.fallback)),
			},
		];
	});
}
