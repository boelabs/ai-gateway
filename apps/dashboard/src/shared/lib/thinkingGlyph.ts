/*
 * The thinking glyph drawn beside work in progress: a sparkle that melts through two blobs into a
 * circle and back while it turns, and a small star that blooms when the circle forms. Every path
 * shares the same commands (M, four cubic curves, Z), so a frame is their points interpolated,
 * scaled and turned.
 *
 * A frame comes from a clock, not from when its glyph appeared: every glyph is at the same point of
 * its cycle, so the line that replaces another (waiting, then the first step) carries on without a
 * jump.
 */
export const SPARKLE_PATH =
	"M 12 3 C 12.9 7.4 16.6 11.1 21 12 C 16.6 12.9 12.9 16.6 12 21 C 11.1 16.6 7.4 12.9 3 12 C 7.4 11.1 11.1 7.4 12 3 Z";
const BLOB_A_PATH =
	"M 12 4.2 C 16.8 3.4 20.6 7.2 19.8 12 C 20.6 16.4 16.4 20.6 12 19.8 C 7.8 20.6 3.4 16.8 4.2 12 C 3.4 7.6 7.2 3.4 12 4.2 Z";
const CIRCLE_PATH =
	"M 12 5 C 15.87 5 19 8.13 19 12 C 19 15.87 15.87 19 12 19 C 8.13 19 5 15.87 5 12 C 5 8.13 8.13 5 12 5 Z";
const BLOB_B_PATH =
	"M 12 3.6 C 16.4 4.6 18.6 8 19.2 12 C 18.6 16.2 16.2 19.4 12 20.4 C 8 19.4 5.2 16.4 4.8 12 C 5.4 7.8 7.6 4.4 12 3.6 Z";
export const TWINKLE_PATH =
	"M 19 2.5 C 19.18 4.32 19.68 4.82 21.5 5 C 19.68 5.18 19.18 5.68 19 7.5 C 18.82 5.68 18.32 5.18 16.5 5 C 18.32 4.82 18.82 4.32 19 2.5 Z";

/** One timeline for the whole glyph, so the morph, the breathing and the twinkle stay together. */
export const GLYPH_CYCLE_MS = 4000;
const TIMES = [0, 0.3, 0.5, 0.7, 1];

const pointsOf = (path: string) =>
	path
		.split(" ")
		.filter((token) => !/^[MCZ]$/u.test(token))
		.map(Number);

const SHAPES = [
	SPARKLE_PATH,
	BLOB_A_PATH,
	CIRCLE_PATH,
	BLOB_B_PATH,
	SPARKLE_PATH,
].map(pointsOf);
const SCALES = [1, 0.9, 0.78, 0.9, 1];
const TWINKLE = pointsOf(TWINKLE_PATH);
const TWINKLE_OPACITIES = [0, 0, 1, 0, 0];
const TWINKLE_TURNS = [0, 45, 90, 135, 180];
const TWINKLE_SCALES = [0.2, 0.5, 1, 0.5, 0.2];

/** The keyframe a point of the cycle falls after, and how far it is towards the next, eased. */
function segmentAt(progress: number) {
	// The last keyframe at or before this point (the build targets a library without findLastIndex).
	let index = 0;
	for (const [i, time] of TIMES.entries()) {
		if (time <= progress) {
			index = i;
		}
	}
	const next = Math.min(index + 1, TIMES.length - 1);
	const span = (TIMES[next] ?? 0) - (TIMES[index] ?? 0);
	const t = span > 0 ? (progress - (TIMES[index] ?? 0)) / span : 0;
	// Smoothstep: an ease in and out without an easing library.
	return { index, next, eased: t * t * (3 - 2 * t) };
}

function mix(
	values: readonly number[],
	index: number,
	next: number,
	t: number,
) {
	const from = values[index] ?? 0;
	return from + ((values[next] ?? from) - from) * t;
}

/** Points scaled and turned about a centre, written back with the paths' commands. */
function pathOf(
	points: readonly number[],
	cx: number,
	cy: number,
	scale: number,
	degrees: number,
) {
	const angle = (degrees * Math.PI) / 180;
	const cos = Math.cos(angle) * scale;
	const sin = Math.sin(angle) * scale;
	const xy = points.flatMap((value, i) => {
		if (i % 2 === 1) {
			return [];
		}
		const dx = value - cx;
		const dy = (points[i + 1] ?? cy) - cy;
		return [
			`${(cx + dx * cos - dy * sin).toFixed(2)} ${(cy + dx * sin + dy * cos).toFixed(2)}`,
		];
	});
	return `M ${xy[0]} C ${xy.slice(1, 4).join(" ")} C ${xy.slice(4, 7).join(" ")} C ${xy.slice(7, 10).join(" ")} C ${xy.slice(10, 13).join(" ")} Z`;
}

/** The glyph at a moment of a clock, in milliseconds. */
export function glyphFrame(time: number) {
	const progress = (time % GLYPH_CYCLE_MS) / GLYPH_CYCLE_MS;
	const { index, next, eased } = segmentAt(progress);
	const from = SHAPES[index] ?? [];
	const to = SHAPES[next] ?? from;
	const shape = from.map(
		(value, i) => value + ((to[i] ?? value) - value) * eased,
	);
	return {
		// The turn runs evenly through the cycle while the rest eases.
		body: pathOf(
			shape,
			12,
			12,
			mix(SCALES, index, next, eased),
			progress * 360,
		),
		// The star turns about its own centre.
		twinkle: pathOf(
			TWINKLE,
			19,
			5,
			mix(TWINKLE_SCALES, index, next, eased),
			mix(TWINKLE_TURNS, index, next, eased),
		),
		twinkleOpacity: mix(TWINKLE_OPACITIES, index, next, eased),
	};
}
