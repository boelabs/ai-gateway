import type { CanonicalRealtimeConversationConfig } from "#core/realtime.ts";
import { REALTIME_AUDIO_SAMPLE_RATE } from "#core/realtime.ts";
import { createPcmResampler } from "#audio/pcm.ts";
import { EventQueue } from "./live.ts";

import {
	type CanonicalRealtimeTranslationConfig,
	type CanonicalRealtimeTranslationEvent,
	TRANSLATION_AUDIO_RATE,
} from "#core/realtimeTranslation.ts";

import type {
	RealtimeConversationHandler,
	RealtimeTranslationSession,
	RealtimeTranslationHandler,
} from "#adapters/types.ts";

/**
 * Gemini Live in translation mode as a realtime translation upstream. Gemini's translation model
 * runs through the Live conversation session (which already reconnects behind the ~10-minute
 * connection cap); this maps OpenAI's translation configuration onto it and keeps only the
 * translation's events. Gemini takes 16 kHz input and answers at 24 kHz, the contract's rate.
 */

/** Gemini translates into English unless told otherwise. */
const DEFAULT_TARGET_LANGUAGE = "en";
/** Gemini has no flush: `finish` waits for its output to go quiet this long. */
const FINISH_QUIET_MS = 1500;
/** And never longer than this. */
const FINISH_MAX_MS = 8000;

export function geminiTranslationConversation(
	config: CanonicalRealtimeTranslationConfig,
): CanonicalRealtimeConversationConfig {
	return {
		model: config.model,
		outputModality: "audio",
		vad: { type: "server_vad", interruptResponse: false, createResponse: true },
		inputTranscription: config.inputTranscription ? {} : null,
		tools: [],
		toolChoice: "auto",
		googleSearch: false,
		truncation: "auto",
		translation: { targetLanguage: config.language ?? DEFAULT_TARGET_LANGUAGE },
	};
}

export function makeGeminiRealtimeTranslationHandler(
	conversation: RealtimeConversationHandler,
): RealtimeTranslationHandler {
	return {
		async connect(config, ctx): Promise<RealtimeTranslationSession> {
			const session = await conversation.connect(
				geminiTranslationConversation(config),
				ctx,
			);
			const queue = new EventQueue<CanonicalRealtimeTranslationEvent>();
			const toGeminiRate = createPcmResampler(
				REALTIME_AUDIO_SAMPLE_RATE,
				TRANSLATION_AUDIO_RATE,
			);
			let lastEventAt = Date.now();
			void (async () => {
				try {
					for await (const event of session.events) {
						lastEventAt = Date.now();
						switch (event.kind) {
							case "input_transcript":
							case "output_transcript":
								queue.push({ kind: event.kind, text: event.text });
								break;
							case "output_audio":
								queue.push({ kind: "output_audio", pcm: event.pcm });
								break;
							case "usage":
								queue.push(event);
								break;
							case "provider_error":
								queue.push(event);
								break;
							default:
								break;
						}
					}
					queue.end();
				} catch (error) {
					queue.fail(error);
				}
			})();

			return {
				appendAudio: (pcm) => session.appendAudio(toGeminiRate(pcm)),
				reconfigure: (next) =>
					session.reconfigure(geminiTranslationConversation(next)),
				async finish() {
					session.flushAudio();
					const startedAt = Date.now();
					lastEventAt = startedAt;
					while (
						Date.now() - lastEventAt < FINISH_QUIET_MS &&
						Date.now() - startedAt < FINISH_MAX_MS
					) {
						await new Promise((resolve) => setTimeout(resolve, 100));
					}
				},
				events: queue.iterate(),
				close() {
					session.close();
					queue.end();
				},
			};
		},
	};
}
