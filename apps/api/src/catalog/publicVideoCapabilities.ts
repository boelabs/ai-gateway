import type { VideoModelProfile } from "#core/videos.ts";
import type { ResolvedModelMetadata } from "./types.ts";
import { videoProfileFor } from "./types.ts";

interface PublicVideoSize {
	size: string;
	aspect_ratio?: string;
	resolution?: string;
}

function intersect<T>(lists: T[][]): T[] {
	return (lists[0] ?? []).filter((value) =>
		lists.every((list) => list.includes(value)),
	);
}

function sizesOf(profile: VideoModelProfile): PublicVideoSize[] | undefined {
	if (!profile.sizes) {
		return;
	}
	return Object.entries(profile.sizes).map(([size, mapping]) => ({
		size,
		...(mapping.aspectRatio ? { aspect_ratio: mapping.aspectRatio } : {}),
		...(mapping.resolution ? { resolution: mapping.resolution } : {}),
	}));
}

function sameSize(a: PublicVideoSize, b: PublicVideoSize): boolean {
	return (
		a.size === b.size &&
		a.aspect_ratio === b.aspect_ratio &&
		a.resolution?.toLowerCase() === b.resolution?.toLowerCase()
	);
}

/**
 * What every deployment of the pool accepts for video generation, by the same rules the gateway
 * validates a request with: a value is listed only if no deployment would refuse it. `sizes` is
 * left out when no deployment declares a size table, since the gateway then forwards dimensions
 * without checking them.
 */
export function publicVideoCapabilities(metas: ResolvedModelMetadata[]) {
	const profiles = metas.flatMap((meta) => {
		const profile = videoProfileFor(meta);
		return meta.operations?.["video.generate"] && profile ? [profile] : [];
	});
	if (!profiles.length) {
		return;
	}
	const tables = profiles.flatMap((profile) => {
		const sizes = sizesOf(profile);
		return sizes ? [sizes] : [];
	});
	const sizes = (tables[0] ?? []).filter((candidate) =>
		tables.every((table) => table.some((entry) => sameSize(entry, candidate))),
	);
	const every = (flag: (profile: VideoModelProfile) => boolean | undefined) =>
		profiles.every((profile) => flag(profile) === true);
	const maxReferences = profiles.flatMap((profile) =>
		profile.maxInputReferences === undefined
			? []
			: [profile.maxInputReferences],
	);
	return {
		tasks: intersect(profiles.map((profile) => profile.tasks ?? [])),
		durations: intersect(
			profiles.map((profile) => profile.durations ?? []),
		).sort((a, b) => Number(a) - Number(b)),
		...(tables.length ? { sizes } : {}),
		qualities: intersect(profiles.map((profile) => profile.qualities ?? [])),
		seed: every((profile) => profile.supportsSeed),
		generate_audio: every((profile) => profile.supportsGenerateAudio),
		input_references: {
			image: every((profile) => profile.supportsImageUrl),
			video: every((profile) => profile.supportsVideoUrl),
			audio: every((profile) => profile.supportsAudioUrl),
			frame_images: every((profile) => profile.supportsFrameImages),
			...(maxReferences.length ? { max: Math.min(...maxReferences) } : {}),
		},
	};
}
