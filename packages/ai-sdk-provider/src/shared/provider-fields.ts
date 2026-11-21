import { isRecord } from "./json.ts";

type Fields = Record<string, unknown>;

/** Array entries with the same `id` are one piece of state: the later copy replaces it. */
function mergeArrays(base: unknown[], next: unknown[]): unknown[] {
	const merged = [...base];
	for (const entry of next) {
		const id = isRecord(entry) ? entry.id : undefined;
		const index =
			id === undefined
				? -1
				: merged.findIndex((current) => isRecord(current) && current.id === id);
		if (index === -1) {
			merged.push(entry);
		} else {
			merged[index] = entry;
		}
	}
	return merged;
}

/**
 * Accumulates the gateway's `provider_specific_fields` across stream deltas: records merge
 * deeply, arrays (encrypted reasoning, thinking blocks) accumulate.
 */
export function mergeProviderFields(
	base: Fields | undefined,
	next: Fields | undefined,
): Fields | undefined {
	if (next === undefined) {
		return base;
	}
	if (base === undefined) {
		return structuredClone(next);
	}
	const merged: Fields = { ...base };
	for (const [key, value] of Object.entries(next)) {
		const current = merged[key];
		if (isRecord(current) && isRecord(value)) {
			merged[key] = mergeProviderFields(current, value);
		} else if (Array.isArray(current) && Array.isArray(value)) {
			merged[key] = mergeArrays(current, value);
		} else {
			merged[key] = structuredClone(value);
		}
	}
	return merged;
}

/**
 * Drops what only describes the stream itself (`openai.responses`: reasoning part progress),
 * which has no meaning once the message is complete.
 */
export function withoutStreamFields(
	fields: Fields | undefined,
): Fields | undefined {
	if (fields === undefined || !isRecord(fields.openai)) {
		return fields;
	}
	const { responses: _responses, ...openai } = fields.openai;
	const { openai: _openai, ...rest } = fields;
	const result = Object.keys(openai).length > 0 ? { ...rest, openai } : rest;
	return Object.keys(result).length > 0 ? result : undefined;
}
