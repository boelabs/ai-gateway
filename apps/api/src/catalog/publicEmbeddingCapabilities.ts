import type { EmbeddingProfile } from "#core/embeddings.ts";
import type { ResolvedModelMetadata } from "./types.ts";
import { embeddingProfileFor } from "./types.ts";

const ENCODING_FORMATS = ["float", "base64"] as const;

/**
 * What every deployment of the pool accepts for embeddings, by the rules the gateway validates a
 * request with. `dimensions` is present only when every deployment can shorten its vectors, with
 * the range they all accept; a profile without `encodingFormats` accepts both formats.
 */
export function publicEmbeddingCapabilities(metas: ResolvedModelMetadata[]) {
	const profiles = metas.flatMap((meta) => {
		const profile = embeddingProfileFor(meta);
		return meta.operations?.["embedding.create"] && profile ? [profile] : [];
	});
	if (!profiles.length) {
		return;
	}
	const shortening = profiles.every((profile) => profile.supportsDimensions);
	const min = Math.max(
		...profiles.map((profile) => profile.minDimensions ?? 1),
	);
	const maxima = profiles.flatMap((profile) => {
		const max = profile.maxDimensions ?? profile.dimensions;
		return max === undefined ? [] : [max];
	});
	const max = maxima.length ? Math.min(...maxima) : undefined;
	const limits = profiles.flatMap((profile: EmbeddingProfile) =>
		profile.maxInputs === undefined ? [] : [profile.maxInputs],
	);
	return {
		...(shortening && (max === undefined || min <= max)
			? { dimensions: { min, ...(max === undefined ? {} : { max }) } }
			: {}),
		encoding_formats: ENCODING_FORMATS.filter((format) =>
			profiles.every(
				(profile) =>
					profile.encodingFormats === undefined ||
					profile.encodingFormats.includes(format),
			),
		),
		...(limits.length ? { max_inputs: Math.min(...limits) } : {}),
	};
}
