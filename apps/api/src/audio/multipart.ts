import { receiveMultipart } from "#http/multipartToDisk.ts";
import type { CanonicalAudioInput } from "#core/audio.ts";
import { GatewayError } from "#core/errors.ts";
import { basename, extname } from "node:path";
import { stat } from "node:fs/promises";
import { env } from "#config/env.ts";

import {
	transcriptionFieldsSchema,
	type TranscriptionFields,
} from "#contracts/openai/audio.ts";

const MAX_AUDIO_BYTES = 26_214_400; // 25 MiB, OpenAI per-file limit

/** Extension -> mime for the formats /v1/audio/transcriptions accepts. */
const AUDIO_MIME: Record<string, string> = {
	flac: "audio/flac",
	mp3: "audio/mpeg",
	mpga: "audio/mpeg",
	mpeg: "audio/mpeg",
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	wav: "audio/wav",
	webm: "audio/webm",
	ogg: "audio/ogg",
	oga: "audio/ogg",
};

/** Multipart fields that arrive as a list (`name[]`). */
const ARRAY_FIELDS = new Set([
	"timestamp_granularities",
	"include",
	"keywords",
	"languages",
]);

export interface ParsedTranscriptionMultipart {
	fields: TranscriptionFields;
	file: CanonicalAudioInput;
	cleanup: () => Promise<void>;
	logBody: Record<string, unknown>;
}

function badMultipart(
	message: string,
	param: string | null = null,
	cause?: unknown,
): GatewayError {
	return new GatewayError({
		class: "bad_request",
		message,
		param,
		code: "invalid_multipart",
		cause,
	});
}

function safeFilename(value: string | undefined): string {
	return [...basename(value || "audio")]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127 ? "_" : character;
		})
		.join("")
		.slice(0, 255);
}

function mimeForFilename(filename: string): string | null {
	const ext = extname(filename).slice(1).toLowerCase();
	return AUDIO_MIME[ext] ?? null;
}

/** Builds the object the schema validates: coerces scalars and groups the array fields. */
function buildFields(
	scalars: Record<string, string>,
	arrays: Record<string, string[]>,
): unknown {
	const out: Record<string, unknown> = { ...scalars };
	if (scalars.temperature !== undefined) {
		const value = Number(scalars.temperature);
		if (Number.isNaN(value)) {
			throw badMultipart("temperature must be a number", "temperature");
		}
		out.temperature = value;
	}
	if (scalars.stream !== undefined) {
		if (scalars.stream !== "true" && scalars.stream !== "false") {
			throw badMultipart("stream must be true or false", "stream");
		}
		out.stream = scalars.stream === "true";
	}
	if (scalars.extra_body !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(scalars.extra_body);
		} catch (cause) {
			throw badMultipart("extra_body must be valid JSON", "extra_body", cause);
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			throw badMultipart("extra_body must be a JSON object", "extra_body");
		}
		out.extra_body = parsed;
	}
	for (const [key, value] of Object.entries(arrays)) {
		out[key] = value;
	}
	return out;
}

export async function parseTranscriptionMultipart(
	request: Request,
): Promise<ParsedTranscriptionMultipart> {
	const received = await receiveMultipart({
		request,
		tmpPrefix: "ai-gateway-audio-",
		limits: {
			files: 1,
			fileSize: MAX_AUDIO_BYTES,
			fields: 1024,
			fieldSize: 65_536,
			parts: 1025,
			totalFileBytes: env.AUDIO_MAX_MULTIPART_BYTES,
		},
		error: badMultipart,
		acceptFile: (name, accepted) => {
			if (name !== "file") {
				return badMultipart(`Unexpected file field "${name}"`, name);
			}
			if (accepted.length > 0) {
				return badMultipart("Only one file is allowed", "file");
			}
			return null;
		},
		fileTooLarge: () => badMultipart("file exceeds 25 MB", "file"),
	});
	const { cleanup } = received;
	const scalars: Record<string, string> = {};
	const arrays: Record<string, string[]> = {};
	const [received0] = received.files;
	const upload = received0
		? { path: received0.path, filename: safeFilename(received0.filename) }
		: null;

	try {
		for (const [name, value] of received.fields) {
			if (name.endsWith("[]")) {
				const base = name.slice(0, -2);
				const list = arrays[base] ?? [];
				list.push(value);
				arrays[base] = list;
				continue;
			}
			if (ARRAY_FIELDS.has(name)) {
				const list = arrays[name] ?? [];
				list.push(value);
				arrays[name] = list;
				continue;
			}
			if (scalars[name] !== undefined) {
				throw badMultipart(`Duplicate field "${name}"`, name);
			}
			scalars[name] = value;
		}
		if (!upload) {
			throw badMultipart("A `file` audio part is required", "file");
		}
		const file = upload as { path: string; filename: string };

		const mimeType = mimeForFilename(file.filename);
		if (!mimeType) {
			throw badMultipart(
				`Unsupported audio format for "${file.filename}" (use flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav or webm)`,
				"file",
			);
		}
		const { size } = await stat(file.path);
		if (size === 0) {
			throw badMultipart("The audio file is empty", "file");
		}
		if (size > env.AUDIO_MAX_MULTIPART_BYTES) {
			throw badMultipart(
				"Multipart body exceeds the configured aggregate limit",
				null,
			);
		}

		const parsed = transcriptionFieldsSchema.safeParse(
			buildFields(scalars, arrays),
		);
		if (!parsed.success) {
			const [first] = parsed.error.issues;
			throw new GatewayError({
				class: "bad_request",
				message: parsed.error.issues
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; "),
				param: first ? first.path.join(".") : null,
			});
		}

		const audio: CanonicalAudioInput = {
			path: file.path,
			filename: file.filename,
			mimeType,
			sizeBytes: size,
		};
		return {
			fields: parsed.data,
			file: audio,
			cleanup,
			logBody: {
				...parsed.data,
				file: {
					filename: audio.filename,
					mime_type: audio.mimeType,
					bytes: audio.sizeBytes,
				},
			},
		};
	} catch (error) {
		await cleanup();
		if (GatewayError.is(error)) {
			throw error;
		}
		throw badMultipart(
			error instanceof Error ? error.message : "Invalid multipart body",
			null,
		);
	}
}
