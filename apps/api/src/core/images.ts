import type { Quality, QualityLevel } from "./quality.ts";
import type { Usage } from "./usage.ts";

export type ImageOperation = "generation" | "edit";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageBackground = "transparent" | "opaque" | "auto";
/** The canonical ladder (see ./quality.ts). DALL·E's `standard`/`hd` are normalized away at the
 * contract boundary and translated back per model via `qualityMappings`. */
export type ImageQuality = Quality;
type ImageResponseFormat = "b64_json";
/** Output tiers a request can name with `resolution`, as the size tables' `imageSize` spells them. */
export const IMAGE_RESOLUTIONS = ["512", "1K", "2K", "4K"] as const;
export type ImageResolution = (typeof IMAGE_RESOLUTIONS)[number];
/** The tier providers that take one fall back to when it is omitted (Gemini's `imageSize`). */
const DEFAULT_RESOLUTION: ImageResolution = "1K";

/** A file validated and stored temporarily during a multipart request. */
export interface CanonicalImageInput {
	path: string;
	filename: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	sizeBytes: number;
	width: number;
	height: number;
	hasAlpha?: boolean;
}

export interface CanonicalImageRequest {
	operation: ImageOperation;
	model: string;
	prompt: string;
	images?: CanonicalImageInput[];
	mask?: CanonicalImageInput;
	background?: ImageBackground;
	inputFidelity?: "high" | "low";
	moderation?: "low" | "auto";
	n?: number;
	outputCompression?: number;
	outputFormat?: ImageOutputFormat;
	partialImages?: number;
	quality?: ImageQuality;
	responseFormat?: ImageResponseFormat;
	size?: string;
	/**
	 * `W:H`, the alternative to `size`: each candidate resolves it, with `resolution`, to an entry of
	 * its own size table (see withResolvedDimensions), so adapters only ever see `size`.
	 */
	aspectRatio?: string;
	/**
	 * Output tier. Kept past resolution only beside `size: "auto"`, for models that pick the aspect
	 * ratio themselves but take a tier (see matchImageDimensions).
	 */
	resolution?: ImageResolution;
	stream: boolean;
	style?: "vivid" | "natural";
	user?: string;
	extraBody?: Record<string, unknown>;
}

export interface ImageUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	inputImageTokens?: number;
	inputTextTokens?: number;
	outputImageTokens?: number;
	outputTextTokens?: number;
}

/**
 * An image endpoint's usage in canonical form. Output the upstream did not split by modality is
 * counted as image output: the endpoint exists to produce images, and pricing a whole image at the
 * text rate is the error that undercharges by an order of magnitude.
 */
export function imageUsageToCore(u: ImageUsage | undefined): Usage | null {
	if (!u) {
		return null;
	}
	const outputImageTokens =
		u.outputImageTokens ??
		(u.outputTextTokens === undefined
			? u.outputTokens
			: Math.max(0, u.outputTokens - u.outputTextTokens));
	return {
		promptTokens: u.inputTokens,
		completionTokens: u.outputTokens,
		totalTokens: u.totalTokens,
		...(u.inputImageTokens === undefined
			? {}
			: { promptImageTokens: u.inputImageTokens }),
		completionImageTokens: outputImageTokens,
	};
}

/**
 * Usage of an image response: the provider's token usage plus the images it produced, for models
 * priced per image. Without token usage the tokens are marked `estimated` for the router to fill.
 */
export function imageResponseUsage(
	u: ImageUsage | undefined,
	output: {
		images: number;
		size?: string | undefined;
		quality?: string | undefined;
	},
): Usage | null {
	const tokens = imageUsageToCore(u);
	if (output.images <= 0) {
		return tokens;
	}
	return {
		...(tokens ?? {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			estimated: true,
		}),
		outputImages: output.images,
		...(output.size === undefined ? {} : { outputImageSize: output.size }),
		...(output.quality === undefined
			? {}
			: { outputImageQuality: output.quality }),
	};
}

export interface CanonicalImageData {
	b64Json: string;
	revisedPrompt?: string;
	mimeType?: string;
	width?: number;
	height?: number;
}

export interface CanonicalImageResponse {
	created: number;
	data: CanonicalImageData[];
	background?: ImageBackground;
	outputFormat?: ImageOutputFormat;
	quality?: ImageQuality;
	size?: string;
	usage?: ImageUsage;
}

export type CanonicalImageStreamEvent =
	| {
			kind: "partial";
			operation: ImageOperation;
			image: CanonicalImageData;
			partialImageIndex: number;
			createdAt: number;
			background?: ImageBackground;
			outputFormat?: ImageOutputFormat;
			quality?: ImageQuality;
			size?: string;
	  }
	| {
			kind: "completed";
			operation: ImageOperation;
			image: CanonicalImageData;
			createdAt: number;
			background?: ImageBackground;
			outputFormat?: ImageOutputFormat;
			quality?: ImageQuality;
			size?: string;
			usage?: ImageUsage;
	  };

export interface ImageSizeMapping {
	/** Native fields for image-config transports. */
	aspectRatio?: string;
	imageSize?: string;
}

/**
 * Canonical constraints of an image model. Two sets of fields:
 *  - **Client contract**: what the client can request; the gateway validates the request against this.
 *  - **Gateway behavior**: how it operates internally. Optional, with safe defaults; the operator of a
 *    custom model normally only declares the client contract.
 */
export interface ImageModelProfile {
	// ── Client contract (request validation) ──
	maxPromptChars?: number;
	maxInputImages?: number;
	maxImageBytes?: number;
	maxTotalInputBytes?: number;
	maxN?: number;
	supportsMask?: boolean;
	supportsInputFidelity?: boolean;
	supportsModeration?: boolean;
	supportsStyle?: boolean;
	supportsTransparentBackground?: boolean;
	outputFormats?: ImageOutputFormat[];
	/** The rungs this model exposes. Absent means it has no quality knob at all. */
	qualities?: QualityLevel[];
	responseFormats?: ImageResponseFormat[];
	/**
	 * Exact accepted dimensions. The first entry is the model's default: `size: "auto"` (or an
	 * omitted size) resolves to it when the model has no native auto (`autoSize` absent).
	 */
	sizes?: Record<string, ImageSizeMapping>;
	/**
	 * Declares native support for `size: "auto"` (the model picks the dimensions itself, e.g. from
	 * the input images of an edit). An empty object means "send no size fields / forward the native
	 * auto value"; set mapping fields when the provider needs an explicit native translation.
	 */
	autoSize?: ImageSizeMapping;
	arbitrarySize?: {
		divisibleBy: number;
		minAspectRatio: number;
		maxAspectRatio: number;
		maxWidth: number;
		maxHeight: number;
		maxPixels?: number;
	};

	// ── Gateway behavior (internal; safe defaults if omitted) ──
	/** The provider emits native streaming events; if not, the gateway synthesizes the final one. */
	supportsNativeStreaming?: boolean;
	/** false when the gateway must transcode the format/compression and not forward those fields. */
	nativeOutputFormat?: boolean;
	nativeOutputCompression?: boolean;
	/**
	 * false when the provider has no `response_format` field for this model and rejects it. The
	 * gpt-image series always returns base64 and errors on the parameter; DALL·E defaults to URLs and
	 * needs it. Absent means "send it", which is what every provider that has the field expects.
	 */
	nativeResponseFormat?: boolean;
	/**
	 * Native translation of each canonical rung, for models that do not speak the ladder: `quality` is
	 * the value sent upstream in place of the rung (DALL·E's `standard`/`hd`), `thinkingLevel` the
	 * Gemini image models' thinking control. Keyed by rung - `auto` never reaches an adapter.
	 */
	qualityMappings?: Partial<
		Record<
			QualityLevel,
			{ quality?: string; thinkingLevel?: "minimal" | "low" | "high" }
		>
	>;
}

/** The provider-facing dimensions resolved from the requested `size` via the profile. */
export interface ResolvedImageSize {
	/** Exact WIDTHxHEIGHT, or the literal `auto` for models with native auto support. */
	size?: string;
	aspectRatio?: string;
	imageSize?: string;
}

/**
 * Resolves the requested `size` against the profile's size table. `auto` (and an omitted size,
 * which is equivalent) resolves to the profile's `autoSize` mapping when the model supports auto
 * natively, and falls back to the first `sizes` entry — the model's default — otherwise, so every
 * image model accepts `size: "auto"` deterministically. Returns undefined when the profile
 * declares nothing to send.
 */
export function resolveImageSize(
	req: Pick<CanonicalImageRequest, "size" | "resolution">,
	profile: ImageModelProfile | undefined,
): ResolvedImageSize | undefined {
	if (req.size && req.size !== "auto") {
		const mapping = profile?.sizes?.[req.size];
		return {
			size: req.size,
			...(mapping?.aspectRatio ? { aspectRatio: mapping.aspectRatio } : {}),
			...(mapping?.imageSize ? { imageSize: mapping.imageSize } : {}),
		};
	}
	if (profile?.autoSize) {
		const imageSize = req.resolution ?? profile.autoSize.imageSize;
		return {
			size: "auto",
			...(profile.autoSize.aspectRatio
				? { aspectRatio: profile.autoSize.aspectRatio }
				: {}),
			...(imageSize ? { imageSize } : {}),
		};
	}
	const [first] = Object.entries(profile?.sizes ?? {});
	if (!first) {
		return undefined;
	}
	const [size, mapping] = first;
	return {
		size,
		...(mapping.aspectRatio ? { aspectRatio: mapping.aspectRatio } : {}),
		...(mapping.imageSize ? { imageSize: mapping.imageSize } : {}),
	};
}

function greatestCommonDivisor(a: number, b: number): number {
	return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

function reducedRatio(width: number, height: number): string {
	const divisor = greatestCommonDivisor(width, height);
	return `${width / divisor}:${height / divisor}`;
}

/** `W:H` in lowest terms (`32:18` is `16:9`), or undefined when it is not a ratio. */
export function normalizeAspectRatio(value: string): string | undefined {
	const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(value);
	return match ? reducedRatio(Number(match[1]), Number(match[2])) : undefined;
}

/**
 * The ratio a size-table entry produces, as people write it: its native mapping (`21:9`), else its
 * own WIDTHxHEIGHT in lowest terms. Only for showing; compare with entryAspectRatio.
 */
function entryAspectRatioLabel(
	key: string,
	mapping: ImageSizeMapping,
): string | undefined {
	if (mapping.aspectRatio && normalizeAspectRatio(mapping.aspectRatio)) {
		return mapping.aspectRatio;
	}
	const match = /^([1-9]\d*)x([1-9]\d*)$/u.exec(key);
	return match ? reducedRatio(Number(match[1]), Number(match[2])) : undefined;
}

/** The ratio a size-table entry produces, in lowest terms so `21:9` and `7:3` compare equal. */
function entryAspectRatio(
	key: string,
	mapping: ImageSizeMapping,
): string | undefined {
	const label = entryAspectRatioLabel(key, mapping);
	return label === undefined ? undefined : normalizeAspectRatio(label);
}

/**
 * What a model accepts for `aspect_ratio` and `resolution`, in the order its size table lists them.
 * A ratio appears once, under the provider's own spelling (`21:9`, not its lowest terms `7:3`).
 */
export function imageDimensionOptions(profile: ImageModelProfile | undefined): {
	aspectRatios: string[];
	resolutions: ImageResolution[];
} {
	const aspectRatios = new Map<string, string>();
	const resolutions = new Set<ImageResolution>();
	for (const [key, mapping] of Object.entries(profile?.sizes ?? {})) {
		const label = entryAspectRatioLabel(key, mapping);
		const ratio = label === undefined ? undefined : normalizeAspectRatio(label);
		if (
			label !== undefined &&
			ratio !== undefined &&
			!aspectRatios.has(ratio)
		) {
			aspectRatios.set(ratio, label);
		}
		if (
			(IMAGE_RESOLUTIONS as readonly string[]).includes(mapping.imageSize ?? "")
		) {
			resolutions.add(mapping.imageSize as ImageResolution);
		}
	}
	return {
		aspectRatios: [...aspectRatios.values()],
		resolutions: [...resolutions],
	};
}

/**
 * Finds the entry of a model's size table that serves `aspect_ratio` and/or `resolution`: one whose
 * ratio (native mapping, else its own WIDTHxHEIGHT) and tier both match, first in table order. A
 * ratio alone prefers the default tier (1K, or an entry with no tier) wherever the table lists it. A
 * tier alone on a model with native auto keeps the ratio automatic (`size: "auto"` plus the tier)
 * when some entry serves that tier.
 *
 * Only declared entries count: a tier is never guessed for an exact-size entry that does not map
 * one, and nothing is computed from `arbitrarySize`. Undefined means the model cannot serve it.
 */
export function matchImageDimensions(
	req: Pick<CanonicalImageRequest, "aspectRatio" | "resolution">,
	profile: ImageModelProfile | undefined,
): { size: string; resolution?: ImageResolution } | undefined {
	const ratio =
		req.aspectRatio === undefined
			? undefined
			: normalizeAspectRatio(req.aspectRatio);
	if (req.aspectRatio !== undefined && ratio === undefined) {
		return undefined;
	}
	const entries = Object.entries(profile?.sizes ?? {});
	const { resolution } = req;
	if (
		ratio === undefined &&
		resolution !== undefined &&
		profile?.autoSize &&
		entries.some(([, mapping]) => mapping.imageSize === resolution)
	) {
		return { size: "auto", resolution };
	}
	const matches = entries.filter(
		([key, mapping]) =>
			(ratio === undefined || entryAspectRatio(key, mapping) === ratio) &&
			(resolution === undefined || mapping.imageSize === resolution),
	);
	// Without a tier, the provider's own default wins over table order: a table may list a smaller
	// tier first (Gemini 3.1 Flash Image puts 512 before 1K).
	const match =
		resolution === undefined
			? (matches.find(
					([, mapping]) =>
						mapping.imageSize === undefined ||
						mapping.imageSize === DEFAULT_RESOLUTION,
				) ?? matches[0])
			: matches[0];
	return match ? { size: match[0] } : undefined;
}

/**
 * The request to execute against one model: `aspect_ratio`/`resolution` replaced by the `size` that
 * model serves them with, so routing, pricing, the output-size check and every transport see an
 * ordinary size. The same object when there is nothing to resolve or no match (validation refuses
 * that candidate first).
 */
export function withResolvedDimensions<T extends CanonicalImageRequest>(
	request: T,
	profile: ImageModelProfile | undefined,
): T {
	if (request.aspectRatio === undefined && request.resolution === undefined) {
		return request;
	}
	const choice = matchImageDimensions(request, profile);
	if (!choice) {
		return request;
	}
	const next: T = { ...request, size: choice.size };
	delete next.aspectRatio;
	if (choice.resolution === undefined) {
		delete next.resolution;
	} else {
		next.resolution = choice.resolution;
	}
	return next;
}
