/**
 * Parses a JSON response body without holding its large strings in memory. Google returns an
 * Interactions video inline as one base64 string (tens of megabytes at 1080p or 4K): read whole,
 * the text, the parsed string and the decoded bytes coexist. Here any string value longer than
 * `LIFT_THRESHOLD` characters is streamed to `onLifted` as it arrives and replaced in the parsed
 * result by `liftedPlaceholder(index)`, so the rest of the document parses as usual.
 */

/** Strings longer than this are lifted out of the parsed document. */
export const LIFT_THRESHOLD = 1_000_000;

const PLACEHOLDER_PREFIX = "\u0000lifted:";

export function liftedPlaceholder(index: number): string {
	return `${PLACEHOLDER_PREFIX}${index}`;
}

/** The index of a lifted string, if `value` is a placeholder for one. */
export function liftedIndex(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.startsWith(PLACEHOLDER_PREFIX)) {
		return undefined;
	}
	const index = Number(value.slice(PLACEHOLDER_PREFIX.length));
	return Number.isInteger(index) ? index : undefined;
}

export interface LiftedSink {
	/** A piece of lifted string `index`, already unescaped. */
	chunk: (index: number, text: string) => void;
	/** Lifted string `index` is complete. */
	end: (index: number) => void;
}

const ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};

/**
 * Reads `body` and parses it as JSON, lifting large strings out to `sink`. Throws a SyntaxError
 * when the body is not JSON, as JSON.parse would.
 */
export async function parseJsonLifting(
	body: ReadableStream<Uint8Array>,
	sink?: LiftedSink,
	threshold = LIFT_THRESHOLD,
): Promise<unknown> {
	const out: string[] = [];
	let inString = false;
	// Raw (still escaped) text of the current string while it is short enough to keep.
	let raw: string[] = [];
	let rawLength = 0;
	let lifted: number | undefined;
	let liftedCount = 0;
	// Text left over from the previous chunk: an escape sequence cut by the chunk boundary.
	let carry = "";

	const consume = (chunk: string, final: boolean) => {
		const text = carry + chunk;
		carry = "";
		let i = 0;
		while (i < text.length) {
			if (!inString) {
				const quote = text.indexOf('"', i);
				if (quote === -1) {
					out.push(text.slice(i));
					return;
				}
				out.push(text.slice(i, quote + 1));
				inString = true;
				raw = [];
				rawLength = 0;
				lifted = undefined;
				i = quote + 1;
				continue;
			}
			const quote = text.indexOf('"', i);
			const backslash = text.indexOf("\\", i);
			const stop =
				backslash !== -1 && (quote === -1 || backslash < quote)
					? backslash
					: quote;
			const segmentEnd = stop === -1 ? text.length : stop;
			if (segmentEnd > i) {
				const segment = text.slice(i, segmentEnd);
				if (lifted === undefined) {
					raw.push(segment);
					rawLength += segment.length;
				} else {
					sink?.chunk(lifted, segment);
				}
			}
			if (lifted === undefined && rawLength > threshold) {
				// The buffered text ends outside any escape sequence, so it parses on its own.
				lifted = liftedCount++;
				sink?.chunk(lifted, JSON.parse(`"${raw.join("")}"`) as string);
				raw = [];
				rawLength = 0;
			}
			if (stop === -1) {
				return;
			}
			if (stop === quote) {
				if (lifted === undefined) {
					out.push(raw.join(""), '"');
				} else {
					sink?.end(lifted);
					out.push(liftedPlaceholder(lifted).replace("\u0000", "\\u0000"), '"');
				}
				inString = false;
				i = quote + 1;
				continue;
			}
			// An escape sequence: `\x`, or `\uXXXX`.
			const length = text[stop + 1] === "u" ? 6 : 2;
			if (stop + length > text.length) {
				if (final) {
					throw new SyntaxError("Unterminated escape sequence in JSON");
				}
				carry = text.slice(stop);
				return;
			}
			const sequence = text.slice(stop, stop + length);
			if (lifted === undefined) {
				raw.push(sequence);
				rawLength += sequence.length;
			} else {
				const escaped =
					length === 6
						? String.fromCharCode(Number.parseInt(sequence.slice(2), 16))
						: ESCAPES[sequence[1] ?? ""];
				if (escaped === undefined) {
					throw new SyntaxError(`Bad escape ${sequence} in JSON`);
				}
				sink?.chunk(lifted, escaped);
			}
			i = stop + length;
		}
	};

	const decoder = new TextDecoder();
	const reader = body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		consume(decoder.decode(value, { stream: true }), false);
	}
	consume(decoder.decode(), true);
	return JSON.parse(out.join(""));
}

/**
 * A sink that base64-decodes every lifted string into byte chunks, decoding as the text arrives
 * so the base64 text is never held whole.
 */
export function base64LiftedSink(): LiftedSink & {
	bytes: (index: number) => Uint8Array[] | undefined;
} {
	const decoded = new Map<number, Uint8Array[]>();
	const pending = new Map<number, string>();
	const decode = (index: number, text: string) => {
		const chunks = decoded.get(index) ?? [];
		decoded.set(index, chunks);
		if (text) {
			chunks.push(Buffer.from(text, "base64"));
		}
	};
	return {
		chunk(index, text) {
			const clean = /\s/u.test(text) ? text.replace(/\s+/gu, "") : text;
			const value = (pending.get(index) ?? "") + clean;
			const whole = value.length - (value.length % 4);
			pending.set(index, value.slice(whole));
			decode(index, value.slice(0, whole));
		},
		end(index) {
			decode(index, pending.get(index) ?? "");
			pending.delete(index);
		},
		bytes(index) {
			return decoded.get(index);
		},
	};
}
