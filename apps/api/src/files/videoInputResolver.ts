/** Secure materialization of the media URLs in a video-generation request. */

import type { CanonicalVideoRequest, VideoUrlReference } from "#core/videos.ts";
import type { DeploymentCandidate } from "#gateway/deploymentCandidates.ts";
import type { ContentPartInputSupport } from "#adapters/types.ts";
import type { UpstreamTransport } from "#core/transport.ts";
import { AsyncSemaphore } from "./asyncSemaphore.ts";

import {
	MAX_PORTABLE_CONTENT_INPUT_BYTES,
	type ResolverDependencies,
	type MaterializedInput,
	MAX_CONCURRENT_FETCHES,
	DEFAULT_DEPENDENCIES,
	candidateInputError,
	type ContentSource,
	contentInputBudget,
	assertImageContent,
	parseSafeHttpsUrl,
	decodeDataUrl,
	requestError,
	mimeMatches,
	fetchInput,
} from "./requestContentInputs.ts";

export interface VideoInputResolutionMetadata {
	materializedAudio: number;
	materializedImages: number;
	materializedVideo: number;
	totalBytes: number;
}

export interface ResolvedVideoInputRequest {
	request: CanonicalVideoRequest;
	metadata?: VideoInputResolutionMetadata;
}

type VideoMediaKind = "audio" | "image" | "video";

interface VideoMediaPart {
	kind: VideoMediaKind;
	param: "frame_images" | "input_references";
	url: string;
}

const VIDEO_MEDIA_KINDS: Record<VideoUrlReference["type"], VideoMediaKind> = {
	image_url: "image",
	audio_url: "audio",
	video_url: "video",
};

function videoMediaKind(ref: VideoUrlReference): VideoMediaKind {
	return VIDEO_MEDIA_KINDS[ref.type];
}

function videoMediaParts(request: CanonicalVideoRequest): VideoMediaPart[] {
	return [
		...(request.inputReferences ?? [])
			.filter((ref): ref is VideoUrlReference => ref.type !== "file_id")
			.map((ref) => ({
				kind: videoMediaKind(ref),
				param: "input_references" as const,
				url: ref.url,
			})),
		...(request.frameImages ?? []).map((frame) => ({
			kind: "image" as const,
			param: "frame_images" as const,
			url: frame.url,
		})),
	];
}

function videoSource(
	url: string,
	kind: VideoMediaKind,
	param: string,
): ContentSource {
	if (url.length === 0) {
		throw requestError(
			`${kind} input source is empty`,
			`invalid_${kind}_url`,
			`${kind}_url cannot be empty.`,
			param,
		);
	}
	if (/^data:/iu.test(url)) {
		return { kind: "data_url", value: url };
	}
	parseSafeHttpsUrl(url, kind, param);
	return { kind: "url", value: url };
}

function assertVideoMediaSupported(
	part: VideoMediaPart,
	support: ContentPartInputSupport | undefined,
): void {
	if (!support?.sources.includes("data_url")) {
		throw candidateInputError(
			`The selected transport cannot consume materialized ${part.kind} inputs`,
			`unsupported_${part.kind}_input`,
			`The selected deployment cannot consume this ${part.kind} input.`,
			part.param,
		);
	}
}

/**
 * Materializes every video-generation media URL before adapter execution. Remote URLs are never
 * forwarded to providers: each candidate must explicitly accept a data URL for the media kind.
 */
export class VideoInputResolver {
	readonly #request: CanonicalVideoRequest;
	readonly #signal: AbortSignal;
	readonly #dependencies: ResolverDependencies;
	readonly #parts: VideoMediaPart[];
	readonly #materialized = new Map<string, Promise<MaterializedInput>>();
	readonly #fetches = new AsyncSemaphore(MAX_CONCURRENT_FETCHES);
	readonly #budget = contentInputBudget();
	readonly #fetchAbort = new AbortController();

	constructor(
		request: CanonicalVideoRequest,
		signal: AbortSignal,
		dependencies: ResolverDependencies = DEFAULT_DEPENDENCIES,
	) {
		this.#request = request;
		this.#signal = signal;
		this.#dependencies = dependencies;
		this.#parts = videoMediaParts(request);
		for (const part of this.#parts) {
			videoSource(part.url, part.kind, part.param);
		}
	}

	get hasInputs(): boolean {
		return this.#parts.length > 0;
	}

	assertCandidate(
		candidate: DeploymentCandidate,
		transport: UpstreamTransport,
	): void {
		const support = candidate.adapter.contentInputs?.[transport];
		for (const part of this.#parts) {
			assertVideoMediaSupported(part, support?.[part.kind]);
		}
	}

	async #materialize(part: VideoMediaPart): Promise<MaterializedInput> {
		const source = videoSource(part.url, part.kind, part.param);
		const key = `${part.kind}:${source.kind}:${source.value}`;
		let pending = this.#materialized.get(key);
		if (pending === undefined) {
			pending =
				source.kind === "url"
					? this.#fetches
							.run(() =>
								this.#budget.run(
									MAX_PORTABLE_CONTENT_INPUT_BYTES,
									part.param,
									(grant) =>
										fetchInput(
											source.value,
											AbortSignal.any([this.#signal, this.#fetchAbort.signal]),
											this.#dependencies,
											part.kind,
											grant,
											part.param,
										),
								),
							)
							.catch((error: unknown) => {
								this.#fetchAbort.abort(error);
								throw error;
							})
					: Promise.resolve(
							decodeDataUrl(
								source.value,
								undefined,
								part.kind,
								MAX_PORTABLE_CONTENT_INPUT_BYTES,
								part.param,
							),
						);
			this.#materialized.set(key, pending);
		}
		return pending;
	}

	async resolveForCandidate(
		candidate: DeploymentCandidate,
		transport: UpstreamTransport,
	): Promise<ResolvedVideoInputRequest> {
		if (!this.hasInputs) {
			return { request: this.#request };
		}
		this.assertCandidate(candidate, transport);
		const support = candidate.adapter.contentInputs?.[transport];
		const resolved = await Promise.all(
			this.#parts.map(async (part) => {
				const media = await this.#materialize(part);
				if (part.kind === "image") {
					assertImageContent(media, part.param);
				}
				const kindSupport = support?.[part.kind];
				if (
					!(
						media.mimeType.startsWith(`${part.kind}/`) &&
						mimeMatches(media.mimeType, kindSupport?.mimeTypes)
					) ||
					(kindSupport?.maxBytes !== undefined &&
						media.bytes.byteLength > kindSupport.maxBytes)
				) {
					throw candidateInputError(
						`The ${part.kind} input uses unsupported MIME type ${media.mimeType} or exceeds the transport limit`,
						`unsupported_${part.kind}_input`,
						`The selected deployment does not support this ${part.kind} input.`,
						part.param,
					);
				}
				return { media, part };
			}),
		);
		const totalBytes = resolved.reduce(
			(total, item) => total + item.media.bytes.byteLength,
			0,
		);
		if (totalBytes > MAX_PORTABLE_CONTENT_INPUT_BYTES) {
			throw requestError(
				`Video media inputs contain ${totalBytes} bytes, above the ${MAX_PORTABLE_CONTENT_INPUT_BYTES} byte request limit`,
				"content_inputs_too_large",
				"The combined video media inputs exceed the 50 MB limit.",
				"input_references",
			);
		}

		let index = 0;
		// The resolved media are in the order the references were collected, so they are consumed
		// in that order too; running out means the two walks disagree, which is a bug here.
		const nextResolved = () => {
			const entry = resolved[index++];
			if (entry === undefined) {
				throw new Error("Resolved media ran out before its references did");
			}
			return entry;
		};
		const inputReferences = this.#request.inputReferences?.map((ref) => {
			if (ref.type === "file_id") {
				return ref;
			}
			const { media } = nextResolved();
			return { ...ref, url: media.dataUrl };
		});
		const frameImages = this.#request.frameImages?.map((frame) => {
			const { media } = nextResolved();
			return { ...frame, url: media.dataUrl };
		});
		return {
			request: {
				...this.#request,
				...(inputReferences === undefined ? {} : { inputReferences }),
				...(frameImages === undefined ? {} : { frameImages }),
			},
			metadata: {
				materializedAudio: resolved.filter((item) => item.part.kind === "audio")
					.length,
				materializedImages: resolved.filter(
					(item) => item.part.kind === "image",
				).length,
				materializedVideo: resolved.filter((item) => item.part.kind === "video")
					.length,
				totalBytes,
			},
		};
	}
}

export function createVideoInputResolver(
	request: CanonicalVideoRequest,
	signal: AbortSignal,
	dependencies?: Partial<ResolverDependencies>,
): VideoInputResolver {
	return new VideoInputResolver(request, signal, {
		...DEFAULT_DEPENDENCIES,
		...dependencies,
	});
}
