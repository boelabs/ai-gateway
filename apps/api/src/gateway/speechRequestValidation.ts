import type { ResolvedModelMetadata } from "#catalog/types.ts";
import type { CanonicalSpeechRequest } from "#core/speech.ts";
import { speechProfileFor } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

function unsupported(param: string, message: string): never {
	throw new GatewayError({
		class: "bad_request",
		message,
		code: "unsupported_parameter",
		param,
		publicMessage: message,
	});
}

/**
 * Refuses, before any upstream call, what the model's speech profile cannot honor. The gateway does
 * not transcode audio or change its speed, so a format or speed the provider lacks is an error rather
 * than a silent substitute.
 */
export function assertSpeechRequestSupported(
	req: CanonicalSpeechRequest,
	meta: ResolvedModelMetadata,
): void {
	const profile = speechProfileFor(meta);
	if (!profile) {
		unsupported("model", `Model ${req.model} does not generate speech.`);
	}
	if (
		req.responseFormat !== undefined &&
		!profile.responseFormats.includes(req.responseFormat)
	) {
		unsupported(
			"response_format",
			`Model ${req.model} returns ${profile.responseFormats.join(", ")} audio, not ${req.responseFormat}.`,
		);
	}
	if (req.instructions !== undefined && !profile.supportsInstructions) {
		unsupported(
			"instructions",
			`Model ${req.model} does not accept instructions.`,
		);
	}
	if (req.speed !== undefined && req.speed !== 1 && !profile.supportsSpeed) {
		unsupported("speed", `Model ${req.model} does not support speed.`);
	}
	if (
		profile.maxInputCharacters !== undefined &&
		req.input.length > profile.maxInputCharacters
	) {
		unsupported(
			"input",
			`Model ${req.model} accepts at most ${profile.maxInputCharacters} characters of input.`,
		);
	}
}
