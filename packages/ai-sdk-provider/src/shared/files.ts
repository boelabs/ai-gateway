import { convertToBase64 } from "@ai-sdk/provider-utils";
import type { SharedV4FileData } from "@ai-sdk/provider";

/** A file as the gateway's OpenAI-shaped contracts carry it. */
export type WireFile =
	| { kind: "url"; url: string }
	| { kind: "data"; base64: string; dataUrl: string }
	| { kind: "id"; id: string };

export function toDataUrl(mediaType: string, base64: string): string {
	return `data:${mediaType};base64,${base64}`;
}

/**
 * Resolves AI SDK file data to a URL, inline base64 or a provider file id. References are read
 * under the provider's own names first, then `openai` (the ids the gateway's native OpenAI
 * deployments accept).
 */
export function toWireFile(
	data: SharedV4FileData,
	mediaType: string,
	referenceNames: readonly string[],
): WireFile | undefined {
	switch (data.type) {
		case "url":
			return { kind: "url", url: data.originalUrl ?? data.url.toString() };
		case "data": {
			const base64 = convertToBase64(data.data);
			return { kind: "data", base64, dataUrl: toDataUrl(mediaType, base64) };
		}
		case "text": {
			const base64 = convertToBase64(new TextEncoder().encode(data.text));
			return { kind: "data", base64, dataUrl: toDataUrl(mediaType, base64) };
		}
		case "reference": {
			for (const name of [...referenceNames, "openai"]) {
				const id = data.reference[name];
				if (id !== undefined) {
					return { kind: "id", id };
				}
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/** `wav`/`mp3` are the formats `input_audio` accepts. */
export function audioFormat(mediaType: string): "wav" | "mp3" | undefined {
	switch (mediaType) {
		case "audio/wav":
		case "audio/wave":
		case "audio/x-wav":
			return "wav";
		case "audio/mp3":
		case "audio/mpeg":
			return "mp3";
		default:
			return undefined;
	}
}

export function topLevelType(mediaType: string): string {
	return mediaType.split("/")[0] ?? mediaType;
}
