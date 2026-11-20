import { gatewayForm, gatewayJson, type GatewayRequest } from "./gateway";
import type { ImageOperationOptions, ImageOptions } from "./models";
import { z } from "zod";

/**
 * Image generation and editing: one request, one set of pictures.
 *
 * Which of the two endpoints a run uses is decided by the run itself — a prompt alone is a
 * generation, a prompt with source images is an edit — rather than by a mode switch the operator
 * has to find first. A model that cannot edit simply never offers the attachment.
 */

export const IMAGE_SIZES = [
	"auto",
	"1024x1024",
	"1024x1536",
	"1536x1024",
	"512x512",
	"1792x1024",
	"1024x1792",
] as const;
export const IMAGE_QUALITIES = [
	"auto",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"standard",
	"hd",
] as const;
export const IMAGE_FORMATS = ["png", "jpeg", "webp"] as const;
export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export const IMAGE_STYLES = ["vivid", "natural"] as const;

/**
 * What the operator chose. `undefined` means "not chosen", and an unchosen field is left out of the
 * request entirely rather than sent as a default: the gateway validates every parameter against the
 * model's own profile, and a value nobody asked for is a rejection nobody asked for either.
 */
export interface ImageSettings {
	size?: string;
	quality?: string;
	n?: number;
	background?: string;
	outputFormat?: string;
	outputCompression?: number;
	style?: string;
}

export const emptyImageSettings = (): ImageSettings => ({});

/**
 * What the settings dialog offers for one model. Without the gateway saying what the model takes
 * (an older gateway), every value is offered and the gateway remains the one to refuse.
 */
export interface ImageChoices {
	/** Generation only: an edit keeps the source size. Empty hides the control. */
	sizes: readonly string[];
	qualities: readonly string[];
	backgrounds: readonly string[];
	formats: readonly string[];
	styles: readonly string[];
	/** Most images one run may ask for; 1 hides the control. */
	maxN: number;
	/** Whether a chosen format can be compressed at all. */
	compression: boolean;
}

const MAX_IMAGES_PER_RUN = 10;

function intersect(lists: string[][]): string[] {
	return (lists[0] ?? []).filter((value) =>
		lists.every((list) => list.includes(value)),
	);
}

/**
 * The shared controls apply to whichever request a run turns out to be, so for a model that also
 * edits they offer only what both operations accept.
 */
export function imageChoices(
	options: ImageOptions | undefined,
	canEdit: boolean,
): ImageChoices {
	const generate = options?.generate;
	const operations = [generate, ...(canEdit ? [options?.edit] : [])].filter(
		(entry): entry is ImageOperationOptions => entry !== undefined,
	);
	if (!(options && operations.length)) {
		return {
			sizes: IMAGE_SIZES,
			qualities: IMAGE_QUALITIES,
			backgrounds: IMAGE_BACKGROUNDS,
			formats: IMAGE_FORMATS,
			styles: IMAGE_STYLES,
			maxN: MAX_IMAGES_PER_RUN,
			compression: true,
		};
	}
	const qualities = intersect(operations.map((entry) => entry.qualities));
	const formats = intersect(operations.map((entry) => entry.outputFormats));
	const limits = operations.flatMap((entry) =>
		entry.maxN === undefined ? [] : [entry.maxN],
	);
	return {
		sizes: generate?.sizes.length ? ["auto", ...generate.sizes] : [],
		qualities: qualities.length ? ["auto", ...qualities] : [],
		backgrounds: [
			"auto",
			...(operations.every((entry) => entry.transparentBackground)
				? ["transparent"]
				: []),
			"opaque",
		],
		formats,
		styles: generate?.style ? IMAGE_STYLES : [],
		maxN: Math.min(MAX_IMAGES_PER_RUN, ...limits),
		compression: formats.includes("jpeg") || formats.includes("webp"),
	};
}

/**
 * The settings with whatever the model does not take removed — what switching models leaves behind.
 * Returns the same object when nothing had to go, so a caller can tell.
 */
export function fitImageSettings(
	settings: ImageSettings,
	options: ImageOptions | undefined,
	canEdit: boolean,
): ImageSettings {
	if (!options) {
		return settings;
	}
	const choices = imageChoices(options, canEdit);
	const next = { ...settings };
	const offered: [keyof ImageSettings, readonly string[]][] = [
		["size", choices.sizes],
		["quality", choices.qualities],
		["background", choices.backgrounds],
		["outputFormat", choices.formats],
		["style", choices.styles],
	];
	for (const [key, values] of offered) {
		const value = next[key];
		if (typeof value === "string" && !values.includes(value)) {
			delete next[key];
		}
	}
	if (next.n !== undefined && next.n > choices.maxN) {
		delete next.n;
	}
	if (next.outputCompression !== undefined && !choices.compression) {
		delete next.outputCompression;
	}
	const changed = (Object.keys(settings) as (keyof ImageSettings)[]).some(
		(key) => !(key in next),
	);
	return changed ? next : settings;
}

export interface ImageRun {
	id: string;
	prompt: string;
	/** The source images an edit was run against, as data URLs, so the run reads on its own. */
	sources: string[];
	/** The same sources as files, so the run can be made again without re-attaching them. */
	files: File[];
	model: string;
	settings: ImageSettings;
	state: "running" | "completed" | "failed" | "stopped";
	images: GeneratedImage[];
	revisedPrompt?: string;
	error?: string;
	durationMs?: number;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface GeneratedImage {
	url: string;
	mediaType: string;
}

const imagesResponse = z.object({
	created: z.number().optional(),
	data: z.array(
		z.object({
			b64_json: z.string().optional(),
			url: z.string().optional(),
			revised_prompt: z.string().optional(),
		}),
	),
	output_format: z.enum(IMAGE_FORMATS).optional(),
	usage: z
		.object({
			input_tokens: z.number().optional(),
			output_tokens: z.number().optional(),
			total_tokens: z.number().optional(),
		})
		.optional(),
});

export type ImagesResponse = z.infer<typeof imagesResponse>;

/** The managed fields, named as each endpoint names them. `size` has no meaning for an edit. */
function parameters(
	settings: ImageSettings,
	kind: "generate" | "edit",
): Record<string, string | number> {
	const entries: Record<string, string | number | undefined> = {
		quality: settings.quality,
		n: settings.n,
		background: settings.background,
		output_format: settings.outputFormat,
		output_compression: settings.outputCompression,
		...(kind === "generate"
			? { size: settings.size, style: settings.style }
			: {}),
	};
	return Object.fromEntries(
		Object.entries(entries).filter(
			(entry): entry is [string, string | number] => entry[1] !== undefined,
		),
	);
}

export function generationBody(
	model: string,
	prompt: string,
	settings: ImageSettings,
): Record<string, unknown> {
	return {
		model,
		prompt,
		...parameters(settings, "generate"),
		// The gateway hands back base64 either way; asking for it explicitly keeps a provider that
		// would rather return an expiring URL from doing so.
		response_format: "b64_json",
		stream: false,
	};
}

export function editForm(
	model: string,
	prompt: string,
	files: File[],
	settings: ImageSettings,
): FormData {
	const form = new FormData();
	form.set("model", model);
	form.set("prompt", prompt);
	for (const file of files) {
		form.append("image", file, file.name);
	}
	for (const [key, value] of Object.entries(parameters(settings, "edit"))) {
		form.set(key, String(value));
	}
	return form;
}

export function imagesFrom(response: ImagesResponse): GeneratedImage[] {
	const mediaType = `image/${response.output_format ?? "png"}`;
	return response.data.flatMap((entry) => {
		if (entry.b64_json) {
			return [{ url: `data:${mediaType};base64,${entry.b64_json}`, mediaType }];
		}
		return entry.url ? [{ url: entry.url, mediaType }] : [];
	});
}

export async function runImages(
	input: {
		model: string;
		prompt: string;
		files: File[];
		settings: ImageSettings;
	},
	options: GatewayRequest = {},
): Promise<ImagesResponse> {
	const body = input.files.length
		? await gatewayForm<unknown>(
				"/images/edits",
				editForm(input.model, input.prompt, input.files, input.settings),
				options,
			)
		: await gatewayJson<unknown>(
				"/images/generations",
				generationBody(input.model, input.prompt, input.settings),
				options,
			);
	return imagesResponse.parse(body);
}
