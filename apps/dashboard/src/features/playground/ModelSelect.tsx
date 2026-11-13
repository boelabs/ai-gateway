"use client";

import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { PopoverRoot, PopoverTrigger, Popover } from "#/components/ui/popover";
import type { Capability } from "./capabilities";
import { ScrollArea } from "#/components/ui/primitives/scroll-area";
import { GhostSkeleton } from "#/shared/components/Skeleton";
import { cn } from "#/shared/lib/classes";

import {
	type ReactNode,
	type Ref,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import {
	type CapabilityGroup,
	type PlaygroundModel,
	type ReasoningEffort,
	type ModelChoice,
	capabilityGroups,
	choiceKey,
} from "./models";

import {
	MagnifyingGlassIcon as IconSearch,
	CaretRightIcon as IconCaretRight,
	CaretDownIcon as IconCaretDown,
	CheckIcon as IconCheck,
} from "@phosphor-icons/react/dist/ssr";

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
	none: "None",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

/**
 * The effort a model starts on: medium when it has one, otherwise the middle of what it offers.
 * There is no "default": the slider always says what is sent.
 */
export function defaultEffort(
	efforts: readonly ReasoningEffort[],
): ReasoningEffort | undefined {
	if (efforts.includes("medium")) {
		return "medium";
	}
	return efforts[Math.floor((efforts.length - 1) / 2)];
}

/** The model this turn runs on and, when it reasons, how hard it thinks. */
export interface EffortChoice {
	value: ReasoningEffort;
	options: readonly ReasoningEffort[];
	onChange: (effort: ReasoningEffort) => void;
}

/** The trigger's own geometry, shared with its skeleton so the two cannot drift apart. */
const TRIGGER =
	"flex h-9 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground";

const ROW =
	"flex min-h-9 w-full cursor-pointer items-center gap-1.5 rounded-2xl px-3 text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The playground's model picker, beside the composer: the model's id and its effort on one button.
 *
 * A model that reasons opens on its effort — a row naming the model, which slides over to the list of
 * models, and a stepped slider of the levels it supports, lowest first. A model that does not, or a
 * capability that is not chat, opens straight on the list: there is nothing else to tune here.
 */
export function ModelSelect({
	models,
	capability,
	modelId,
	onSelect,
	effort,
}: {
	models: PlaygroundModel[];
	capability: Capability;
	modelId: string;
	onSelect: (choice: ModelChoice) => void;
	/** Only for a chat model that accepts `reasoning_effort` with at least two levels. */
	effort?: EffortChoice | undefined;
}) {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"effort" | "models">("effort");
	const sliderInput = useRef<HTMLInputElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const tunable = effort !== undefined && effort.options.length > 1;

	return (
		<PopoverRoot
			onOpenChange={(next) => {
				setOpen(next);
				// Every opening starts where it should: on the effort when there is one.
				if (next) {
					setView(tunable ? "effort" : "models");
				}
			}}
			open={open}
		>
			<PopoverTrigger
				aria-label={`Model: ${modelId}${tunable ? `, effort ${EFFORT_LABELS[effort.value]}` : ""}`}
				className={TRIGGER}
			>
				<span className="min-w-0 truncate font-medium text-foreground">
					{modelId}
				</span>
				{tunable ? (
					<span className="shrink-0">{EFFORT_LABELS[effort.value]}</span>
				) : null}
				<IconCaretDown aria-hidden className="size-4 shrink-0" />
			</PopoverTrigger>
			<Popover
				aria-label="Model"
				// Concentric with what it holds: the slider's pill (16px radius) + each view's 6px padding + the
				// 1px border. The views pad themselves, so a scrolling list can reach the edge.
				className="w-80 max-w-[calc(100vw-2rem)] rounded-[23px] p-0"
				initialFocus={tunable && view === "effort" ? sliderInput : search}
				// Above the composer, like the picker it is modelled on; it only flips when there is no room.
				positionerProps={{ align: "end", side: "top", sideOffset: 6 }}
			>
				{tunable ? (
					<SlidingViews
						first={
							<div className="flex flex-col gap-1 p-1.5">
								<button
									aria-label={`Change model: ${modelId}`}
									className={ROW}
									onClick={() => setView("models")}
									type="button"
								>
									<span className="min-w-0 flex-1 truncate text-start font-medium">
										{modelId}
									</span>
									<span className="text-muted-foreground">
										{EFFORT_LABELS[effort.value]}
									</span>
									<IconCaretRight
										aria-hidden
										className="size-3.5 text-muted-foreground"
									/>
								</button>
								<EffortSlider effort={effort} inputRef={sliderInput} />
							</div>
						}
						second={
							<ModelList
								capability={capability}
								inputRef={search}
								modelId={modelId}
								models={models}
								onSelect={(choice) => {
									onSelect(choice);
									setView("effort");
								}}
							/>
						}
						showSecond={view === "models"}
					/>
				) : (
					<ModelList
						capability={capability}
						inputRef={search}
						modelId={modelId}
						models={models}
						onSelect={(choice) => {
							onSelect(choice);
							setOpen(false);
						}}
					/>
				)}
			</Popover>
		</PopoverRoot>
	);
}

/**
 * The catalog, searchable, grouped by what each model can do. A model listed under two capabilities
 * is two choices: the group it is picked from says which experiment this is.
 */
function ModelList({
	models,
	capability,
	modelId,
	onSelect,
	inputRef,
}: {
	models: PlaygroundModel[];
	capability: Capability;
	modelId: string;
	onSelect: (choice: ModelChoice) => void;
	inputRef: Ref<HTMLInputElement>;
}) {
	const [query, setQuery] = useState("");
	const groups = useMemo(() => capabilityGroups(models), [models]);
	const selected = choiceKey(capability, modelId);
	const needle = query.trim().toLowerCase();
	const shown = groups
		.map(
			(group): CapabilityGroup => ({
				...group,
				items: group.items.filter((item) =>
					item.model.id.toLowerCase().includes(needle),
				),
			}),
		)
		.filter((group) => group.items.length > 0);
	return (
		<div className="flex flex-col">
			<div className="flex h-10 items-center gap-2 border-b border-border/60 px-4.5">
				<IconSearch
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<input
					aria-label="Search models"
					className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search models"
					ref={inputRef}
					value={query}
				/>
			</div>
			{/* coss's scroll area reaching the popover's edge: its 2px thumb sits in the list's own
			    padding, against the border, and that padding is the same on every side. */}
			<ScrollArea
				className="h-auto rounded-b-[22px]"
				scrollbar="popup"
				scrollFade
				viewportClassName="max-h-80"
			>
				<div className="px-1.5 pt-1 pb-1.5">
					{shown.length === 0 ? (
						<p className="px-3 py-3 text-sm text-muted-foreground">
							No model matches that name.
						</p>
					) : (
						shown.map((group) => (
							<div
								className="flex flex-col pb-1 last:pb-0"
								key={group.capability}
							>
								{/* One group is no grouping: the label would only repeat the page. */}
								{groups.length > 1 ? (
									<span className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
										{group.label}
									</span>
								) : null}
								{group.items.map((choice) => {
									const active = choice.key === selected;
									return (
										<button
											aria-pressed={active}
											className={ROW}
											key={choice.key}
											onClick={() => onSelect(choice)}
											type="button"
										>
											<span className="min-w-0 flex-1 truncate text-start">
												{choice.model.id}
											</span>
											{active ? (
												<IconCheck
													aria-hidden
													className="size-4"
													weight="bold"
												/>
											) : null}
										</button>
									);
								})}
							</div>
						))
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

/**
 * Two views side by side; the one shown sets the height, so the popup grows and shrinks with it
 * rather than keeping room for the taller one.
 */
function SlidingViews({
	first,
	second,
	showSecond,
}: {
	first: ReactNode;
	second: ReactNode;
	showSecond: boolean;
}) {
	const firstRef = useRef<HTMLDivElement>(null);
	const secondRef = useRef<HTMLDivElement>(null);
	const [height, setHeight] = useState<number | null>(null);
	// Only a switch animates; the first measurement must not grow from zero.
	const [switched, setSwitched] = useState(false);
	const [last, setLast] = useState(showSecond);
	if (last !== showSecond) {
		setLast(showSecond);
		setSwitched(true);
	}

	useLayoutEffect(() => {
		const shown = showSecond ? secondRef.current : firstRef.current;
		if (!shown) {
			return;
		}
		// Measured before paint: an observer reports a frame later, and until then the box would be as
		// tall as the taller view.
		setHeight(shown.offsetHeight);
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setHeight(entry.borderBoxSize[0]?.blockSize ?? null);
			}
		});
		observer.observe(shown);
		if (switched) {
			// The keyboard follows the view that slid in; no scroll, or the clipped box jumps.
			(
				shown.querySelector<HTMLElement>('[aria-pressed="true"]') ??
				shown.querySelector<HTMLElement>("input, button")
			)?.focus({ preventScroll: true });
		}
		return () => observer.disconnect();
	}, [showSecond, switched]);

	const easing =
		"duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";
	return (
		<div
			className={cn(
				"overflow-hidden",
				switched && ["transition-[height]", easing],
			)}
			style={height === null ? undefined : { height }}
		>
			<div
				className={cn(
					"relative flex w-[200%] items-start",
					switched && ["transition-transform", easing],
					showSecond && "-translate-x-1/2",
				)}
			>
				<div
					className={cn(
						"w-1/2 transition-opacity duration-200",
						// The hidden view takes no height: the popup opens at the size of what it shows,
						// instead of opening at the taller view's size and then shrinking (and moving).
						showSecond && "absolute top-0 left-0 opacity-0",
					)}
					inert={showSecond}
					ref={firstRef}
				>
					{first}
				</div>
				<div
					className={cn(
						// Always on the right half of the rail, in flow or not.
						"ms-auto w-1/2 transition-opacity duration-200",
						!showSecond && "absolute top-0 left-1/2 opacity-0",
					)}
					inert={!showSecond}
					ref={secondRef}
				>
					{second}
				</div>
			</div>
		</div>
	);
}

/**
 * A stepped slider over the levels the model supports, lowest first. The track sits in a pill with
 * 4px of padding, so the thumb and the fill have the same air on every side; the thumb keeps its
 * edges inside the track, so the stops sit on a rail inset by its radius (`inset-x-3`, `size-6`).
 */
function EffortSlider({
	effort,
	inputRef,
}: {
	effort: EffortChoice;
	inputRef: Ref<HTMLInputElement>;
}) {
	const levels = effort.options;
	const selectedIndex = Math.max(0, levels.indexOf(effort.value));
	const lastIndex = levels.length - 1;
	// The edge-aligned thumb is measured after mounting; animating from then on would slide it in
	// from the start every time the popup opens.
	const [changed, setChanged] = useState(false);
	const easing =
		"duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none data-dragging:transition-none";
	return (
		<SliderPrimitive.Root
			className="px-1.5 pb-1.5"
			max={lastIndex}
			min={0}
			onValueChange={(next) => {
				const level = levels[next];
				if (level) {
					setChanged(true);
					effort.onChange(level);
				}
			}}
			step={1}
			thumbAlignment="edge"
			value={selectedIndex}
		>
			<SliderPrimitive.Control className="flex h-9 cursor-pointer touch-none items-center select-none">
				{/* The pill around the track: 4px of air on every side of the thumb and the fill. */}
				<div className="w-full rounded-full bg-muted p-1">
					<SliderPrimitive.Track className="relative h-6 w-full">
						<SliderPrimitive.Indicator
							className={cn(
								// Square at its end: that end sits under the thumb's centre, out of sight.
								"rounded-s-full bg-primary",
								// At the first stop it would end under the thumb, and its edge would show.
								selectedIndex === 0 && "invisible",
								changed && ["transition-[width]", easing],
							)}
						/>
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-x-3 inset-y-0"
						>
							{levels.map((level, index) => (
								<span
									className={cn(
										"absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-200",
										index < selectedIndex
											? "bg-primary-foreground/60"
											: "bg-muted-foreground/50",
									)}
									key={level}
									style={{ left: `${(index / lastIndex) * 100}%` }}
								/>
							))}
						</div>
						<SliderPrimitive.Thumb
							aria-label="Reasoning effort"
							className={cn(
								"size-6 rounded-full bg-white shadow-sm transition-[scale] duration-150 active:scale-110 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring motion-reduce:transition-none",
								changed && ["transition-[inset-inline-start,scale]", easing],
							)}
							getAriaValueText={(_formatted, next) => {
								const level = levels[next];
								return level ? EFFORT_LABELS[level] : "";
							}}
							inputRef={inputRef}
						/>
					</SliderPrimitive.Track>
				</div>
			</SliderPrimitive.Control>
		</SliderPrimitive.Root>
	);
}

/**
 * The trigger as it looks before the catalog arrives: same box, a sample id and effort, ghosted.
 * The skeleton cannot know the model, so it keeps the usual length of one.
 */
export function ModelSelectSkeleton() {
	return (
		<GhostSkeleton className="rounded-full">
			<span className={TRIGGER}>
				<span className="min-w-0 truncate font-medium">cheap-chat</span>
				<span className="shrink-0">Medium</span>
				<IconCaretDown aria-hidden className="size-4 shrink-0" />
			</span>
		</GhostSkeleton>
	);
}
