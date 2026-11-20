import type { TimestampGranularity } from "#core/audio.ts";
import type { ResolvedModelMetadata } from "./types.ts";
import { transcriptionProfileFor } from "./types.ts";

const GRANULARITIES: TimestampGranularity[] = ["segment", "word"];

/**
 * What every deployment of the pool accepts for transcription, by the rules the gateway validates
 * a request with. `timestamp_granularities` is empty when timestamps are refused; they also need
 * `response_format=verbose_json`, which the client has to choose.
 */
export function publicTranscriptionCapabilities(
	metas: ResolvedModelMetadata[],
) {
	const profiles = metas.flatMap((meta) => {
		const profile = transcriptionProfileFor(meta);
		return profile ? [profile] : [];
	});
	if (!profiles.length) {
		return;
	}
	const [first, ...rest] = profiles;
	return {
		response_formats: (first?.responseFormats ?? []).filter((format) =>
			rest.every((profile) => profile.responseFormats.includes(format)),
		),
		timestamp_granularities: GRANULARITIES.filter((granularity) =>
			profiles.every(
				(profile) =>
					profile.supportsTimestampGranularities === true &&
					(profile.timestampGranularities === undefined ||
						profile.timestampGranularities.includes(granularity)),
			),
		),
	};
}
