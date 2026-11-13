"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "#/shared/lib/classes";

import {
	type ComponentProps,
	type CSSProperties,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

import {
	glyphFrame,
	SPARKLE_PATH,
	TWINKLE_PATH,
} from "#/shared/lib/thinkingGlyph";

/** How long each word stays on screen. */
const WORD_MS = 3200;
const EASE_STANDARD = [0.4, 0, 0.2, 1] as const;

interface ThinkingIndicatorProps extends ComponentProps<"span"> {
	/** What the work is doing, shown in turn. A single word stays put. */
	words: readonly string[];
}

/**
 * Work in progress: a sparkle that melts into a circle and back, beside words that take turns under
 * a sweeping sheen. It inherits the font size and scales with it. With reduced motion the glyph
 * stands still and the first word stays. Another list of words starts over from its first, so a
 * line that takes over from another reads as one.
 */
export function ThinkingIndicator({
	className,
	words,
	...props
}: ThinkingIndicatorProps) {
	const [first] = words;
	const [shown, setShown] = useState({ first, index: 0 });
	// Other words (the next step's) start over from their first, and the glyph keeps its rhythm.
	if (shown.first !== first) {
		setShown({ first, index: 0 });
	}
	const index = shown.first === first ? shown.index : 0;
	const reduceMotion = useReducedMotion() ?? false;
	const word = words.length > 0 ? (words[index % words.length] ?? "") : "";

	useEffect(() => {
		if (reduceMotion || words.length <= 1) {
			return;
		}
		const timer = setInterval(
			() => setShown((current) => ({ ...current, index: current.index + 1 })),
			WORD_MS,
		);
		return () => clearInterval(timer);
	}, [reduceMotion, words.length]);

	return (
		// A span, not a div, so it can sit inside the button that opens the steps.
		<span
			className={cn(
				"flex min-w-0 items-center gap-[0.6em] text-muted-foreground",
				className,
			)}
			role="status"
			{...props}
		>
			{/* One announcement: the cycling words below are hidden from screen readers. */}
			{words.length > 0 ? <span className="sr-only">{words[0]}…</span> : null}
			<ThinkingGlyph still={reduceMotion} />
			{words.length > 0 ? (
				<span
					aria-hidden="true"
					className="inline-grid min-w-0 overflow-hidden whitespace-nowrap"
				>
					{/* The current word, invisible, sizes the line; the moving words are drawn over it. */}
					<span className="invisible col-start-1 row-start-1">{word}</span>
					{reduceMotion ? (
						<span className="col-start-1 row-start-1">{words[0]}</span>
					) : (
						<AnimatePresence mode="popLayout">
							<motion.span
								animate={{
									y: 0,
									opacity: 1,
									filter: "blur(0px)",
									backgroundPosition: "0% center",
								}}
								className={cn(
									"col-start-1 row-start-1 bg-[length:250%_100%,auto] bg-clip-text text-transparent",
									// The resting text is the muted foreground and the sheen the full one, in
									// both themes.
									"[--ti-base:var(--color-muted-foreground)] [--ti-sheen:var(--color-foreground)]",
									"[background-repeat:no-repeat,padding-box]",
								)}
								exit={{
									y: "-70%",
									opacity: 0,
									filter: "blur(3px)",
									transition: { duration: 0.2, ease: EASE_STANDARD },
								}}
								initial={{
									y: "70%",
									opacity: 0,
									filter: "blur(3px)",
									backgroundPosition: "100% center",
								}}
								key={word}
								style={
									{
										"--ti-spread": `${word.length * 2}px`,
										backgroundImage:
											"linear-gradient(90deg,#0000 calc(50% - var(--ti-spread)),var(--ti-sheen),#0000 calc(50% + var(--ti-spread))), linear-gradient(var(--ti-base),var(--ti-base))",
									} as CSSProperties
								}
								transition={{
									y: { type: "spring", stiffness: 420, damping: 34 },
									opacity: { duration: 0.28, ease: EASE_STANDARD },
									filter: { duration: 0.28, ease: EASE_STANDARD },
									backgroundPosition: {
										duration: 2,
										ease: "linear",
										repeat: Number.POSITIVE_INFINITY,
									},
								}}
							>
								{word}
							</motion.span>
						</AnimatePresence>
					)}
				</span>
			) : null}
		</span>
	);
}

/**
 * The glyph, drawn every frame from the page's animation clock. Every glyph reads the same clock,
 * so the one that replaces another carries on its cycle.
 */
function ThinkingGlyph({ still }: { still: boolean }) {
	const gradientId = useId();
	const body = useRef<SVGPathElement>(null);
	const twinkle = useRef<SVGPathElement>(null);

	useEffect(() => {
		if (still) {
			return;
		}
		const loop = { frame: 0 };
		const draw = (time: number) => {
			const frame = glyphFrame(time);
			body.current?.setAttribute("d", frame.body);
			twinkle.current?.setAttribute("d", frame.twinkle);
			twinkle.current?.setAttribute("opacity", String(frame.twinkleOpacity));
			loop.frame = requestAnimationFrame(draw);
		};
		loop.frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(loop.frame);
	}, [still]);

	return (
		// One line box tall, so it matches the label; the em sizes are for browsers without lh.
		<svg
			aria-hidden="true"
			className="size-[1lh] shrink-0"
			fill="none"
			height="1.5em"
			viewBox="0 0 24 24"
			width="1.5em"
		>
			<defs>
				{/* Depth without a palette: both stops are currentColor, only the opacity ramps. */}
				<linearGradient
					gradientUnits="userSpaceOnUse"
					id={gradientId}
					x1="5"
					x2="20"
					y1="4"
					y2="20"
				>
					<stop offset="0" stopColor="currentColor" stopOpacity="1" />
					<stop offset="1" stopColor="currentColor" stopOpacity="0.4" />
				</linearGradient>
			</defs>
			<path d={SPARKLE_PATH} fill={`url(#${gradientId})`} ref={body} />
			<path
				d={TWINKLE_PATH}
				fill="currentColor"
				opacity={still ? 0.5 : 0}
				ref={twinkle}
			/>
		</svg>
	);
}
