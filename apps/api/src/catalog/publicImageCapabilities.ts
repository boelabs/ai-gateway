import {
	type ImageModelProfile,
	imageDimensionOptions,
	normalizeAspectRatio,
} from "#core/images.ts";
import type { ResolvedModelMetadata } from "./types.ts";
import { imageProfileFor } from "./types.ts";

const OPERATIONS = {
	generate: ["image.generate", "generation"],
	edit: ["image.edit", "edit"],
} as const;

function intersect<T>(lists: T[][]): T[] {
	return intersectBy(lists, (value) => value);
}

/** The first list's values that every list has, judged by `key`. */
function intersectBy<T>(lists: T[][], key: (value: T) => unknown): T[] {
	const keyed = lists.map((list) => new Set(list.map(key)));
	return (lists[0] ?? []).filter((value) =>
		keyed.every((set) => set.has(key(value))),
	);
}

function operationCapabilities(profiles: ImageModelProfile[]) {
	const every = (flag: (profile: ImageModelProfile) => boolean | undefined) =>
		profiles.every((profile) => flag(profile) === true);
	const limit = (value: (profile: ImageModelProfile) => number | undefined) => {
		const values = profiles.flatMap((profile) => {
			const entry = value(profile);
			return entry === undefined ? [] : [entry];
		});
		return values.length ? Math.min(...values) : undefined;
	};
	const maxN = limit((profile) => profile.maxN);
	const maxInputImages = limit((profile) => profile.maxInputImages);
	return {
		sizes: intersect(
			profiles.map((profile) => Object.keys(profile.sizes ?? {})),
		),
		arbitrary_sizes: every((profile) => profile.arbitrarySize !== undefined),
		// Each one is served by every deployment; not every ratio exists at every resolution.
		// Compared in lowest terms, so a provider's `21:9` and another's 2016x864 are one ratio.
		aspect_ratios: intersectBy(
			profiles.map((profile) => imageDimensionOptions(profile).aspectRatios),
			(ratio) => normalizeAspectRatio(ratio) ?? ratio,
		),
		resolutions: intersect(
			profiles.map((profile) => imageDimensionOptions(profile).resolutions),
		),
		qualities: intersect(profiles.map((profile) => profile.qualities ?? [])),
		output_formats: intersect(
			profiles.map((profile) => profile.outputFormats ?? []),
		),
		transparent_background: every(
			(profile) => profile.supportsTransparentBackground,
		),
		style: every((profile) => profile.supportsStyle),
		mask: every((profile) => profile.supportsMask),
		...(maxN === undefined ? {} : { max_n: maxN }),
		...(maxInputImages === undefined
			? {}
			: { max_input_images: maxInputImages }),
	};
}

/**
 * What every deployment of the pool accepts for image generation and editing, by the rules the
 * gateway validates a request with: a value is listed only if no deployment would refuse it.
 * `size: "auto"` and `quality: "auto"` are always accepted, so neither is listed.
 */
export function publicImageCapabilities(metas: ResolvedModelMetadata[]) {
	const result: Partial<
		Record<keyof typeof OPERATIONS, ReturnType<typeof operationCapabilities>>
	> = {};
	for (const [name, [operationId, kind]] of Object.entries(OPERATIONS) as [
		keyof typeof OPERATIONS,
		(typeof OPERATIONS)[keyof typeof OPERATIONS],
	][]) {
		const profiles = metas.flatMap((meta) => {
			const profile = imageProfileFor(meta, kind);
			return meta.operations?.[operationId] && profile ? [profile] : [];
		});
		if (profiles.length) {
			result[name] = operationCapabilities(profiles);
		}
	}
	return Object.keys(result).length ? result : undefined;
}
