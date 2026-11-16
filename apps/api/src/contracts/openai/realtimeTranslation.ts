import type { CanonicalRealtimeTranslationConfig } from "#core/realtimeTranslation.ts";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";

/**
 * OpenAI's realtime translation contract (`/v1/realtime/translations`): the session object, the
 * three client events and the server events, as the gateway renders and parses them.
 */

const noiseReductionSchema = z
	.object({
		type: z.enum(["near_field", "far_field"]),
		strength: z.number().min(0).max(1).optional(),
	})
	.strict();

export const translationSessionUpdateSchema = z
	.object({
		type: z.literal("translation").optional(),
		model: z.string().optional(),
		audio: z
			.object({
				input: z
					.object({
						transcription: z
							.object({ model: z.string().min(1) })
							.strict()
							.nullable()
							.optional(),
						noise_reduction: noiseReductionSchema.nullable().optional(),
					})
					.strict()
					.optional(),
				output: z
					.object({ language: z.string().min(1).nullable().optional() })
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type TranslationSessionUpdate = z.infer<
	typeof translationSessionUpdateSchema
>;

export const translationClientEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("session.update"),
			event_id: z.string().max(512).optional(),
			session: translationSessionUpdateSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("session.input_audio_buffer.append"),
			event_id: z.string().max(512).optional(),
			audio: z.string(),
		})
		.strict(),
	z
		.object({
			type: z.literal("session.close"),
			event_id: z.string().max(512).optional(),
		})
		.strict(),
]);

export type TranslationClientEvent = z.infer<
	typeof translationClientEventSchema
>;

export interface TranslationSessionState {
	id: string;
	/** The public model, from the URL; it cannot change. */
	model: string;
	expiresAt: number;
	language: string | null;
	transcription: { model: string } | null;
	noiseReduction: {
		type: "near_field" | "far_field";
		strength?: number;
	} | null;
}

export function newTranslationSessionState(
	model: string,
	expiresAt: number,
): TranslationSessionState {
	return {
		id: `sess_${randomBytes(12).toString("base64url")}`,
		model,
		expiresAt,
		language: null,
		transcription: null,
		noiseReduction: null,
	};
}

/** A session.update applied to the state; fields it leaves out keep their values. */
export function applyTranslationSessionUpdate(
	state: TranslationSessionState,
	update: TranslationSessionUpdate,
): TranslationSessionState {
	const input = update.audio?.input;
	const output = update.audio?.output;
	return {
		...state,
		...(output?.language === undefined ? {} : { language: output.language }),
		...(input?.transcription === undefined
			? {}
			: { transcription: input.transcription }),
		...(input?.noise_reduction === undefined
			? {}
			: {
					noiseReduction:
						input.noise_reduction === null
							? null
							: {
									type: input.noise_reduction.type,
									strength:
										input.noise_reduction.strength ??
										state.noiseReduction?.strength ??
										1,
								},
				}),
	};
}

export function translationConfigOf(
	state: TranslationSessionState,
): CanonicalRealtimeTranslationConfig {
	return {
		model: state.model,
		...(state.language ? { language: state.language } : {}),
		inputTranscription: state.transcription
			? { model: state.transcription.model }
			: null,
		noiseReduction: state.noiseReduction,
	};
}

export function renderTranslationSession(
	state: TranslationSessionState,
): Record<string, unknown> {
	return {
		id: state.id,
		type: "translation",
		model: state.model,
		expires_at: state.expiresAt,
		audio: {
			input: {
				noise_reduction: state.noiseReduction,
				transcription: state.transcription,
			},
			output: { language: state.language },
		},
	};
}

export function translationEventId(): string {
	return `event_${randomBytes(12).toString("base64url")}`;
}
