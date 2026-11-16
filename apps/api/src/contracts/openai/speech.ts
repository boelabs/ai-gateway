import type { CanonicalSpeechRequest } from "#core/speech.ts";
import { SPEECH_RESPONSE_FORMATS } from "#core/speech.ts";
import { GatewayError } from "#core/errors.ts";
import { z } from "zod/v4";

/** OpenAI's `/v1/audio/speech` body. `voice` is a name, or `{ id }` for a custom voice. */
export const speechRequestSchema = z
	.object({
		model: z.string().min(1),
		input: z.string().min(1),
		voice: z.union([
			z.string().min(1),
			z.object({ id: z.string().min(1) }).strict(),
		]),
		instructions: z.string().optional(),
		response_format: z.enum(SPEECH_RESPONSE_FORMATS).optional(),
		speed: z.number().min(0.25).max(4).optional(),
		stream_format: z.enum(["audio", "sse"]).optional(),
	})
	.strict();

export type OpenAISpeechRequest = z.infer<typeof speechRequestSchema>;

export function speechRequestToCanonical(
	req: OpenAISpeechRequest,
): CanonicalSpeechRequest {
	// The audio is returned whole, which `audio` (raw bytes) already allows; SSE events are not served.
	if (req.stream_format === "sse") {
		const message =
			"stream_format `sse` is not supported; omit it or use `audio`.";
		throw new GatewayError({
			class: "bad_request",
			code: "unsupported_parameter",
			param: "stream_format",
			message,
			publicMessage: message,
		});
	}
	return {
		model: req.model,
		input: req.input,
		voice: typeof req.voice === "string" ? req.voice : req.voice.id,
		...(req.instructions ? { instructions: req.instructions } : {}),
		...(req.response_format ? { responseFormat: req.response_format } : {}),
		...(req.speed === undefined ? {} : { speed: req.speed }),
	};
}
