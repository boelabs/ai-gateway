import type { JSONObject, JSONValue } from "@ai-sdk/provider";

/** `T` with its possibly-undefined properties made optional and never undefined. */
export type Compact<T> = {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
		T[K],
		undefined
	>;
};

/** Drops `undefined` entries so request bodies carry only what the caller set. */
export function compact<T extends Record<string, unknown>>(
	value: T,
): Compact<T> {
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			out[key] = entry;
		}
	}
	return out as Compact<T>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Round-trips a parsed wire value into a JSON value the AI SDK can carry in metadata. */
export function toJSONValue(value: unknown): JSONValue {
	return JSON.parse(JSON.stringify(value ?? null)) as JSONValue;
}

export function toJSONObject(value: unknown): JSONObject {
	const json = toJSONValue(value);
	return isRecord(json) ? (json as JSONObject) : {};
}
