"use client";

import { ScrollArea } from "#/components/ui/primitives/scroll-area";
import { ThinkingIndicator } from "#/components/ui/thinking-indicator";
import type { PlaygroundMessage } from "./transport";
import { Button } from "#/components/ui/button";
import { cn } from "#/shared/lib/classes";
import { SIDE_PANEL_SLOT } from "#/shared/lib/sidePanel";
import { createPortal } from "react-dom";
import { Markdown } from "./Markdown";

import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import {
	type Step,
	type StepBlock,
	runningStep,
	settleSteps,
	stepPhrases,
	stepTitle,
	stepsOf,
	WAITING_PHRASES,
} from "./steps";

import {
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceCollapsible,
	TraceTitle,
	TraceIcon,
	TraceLine,
	Trace,
} from "#/components/ui/trace";

import {
	SheetDescription,
	SheetHeader,
	SheetPopup,
	SheetTitle,
	Sheet,
} from "#/components/ui/sheet";

import {
	CaretRightIcon,
	WrenchIcon,
	BrainIcon,
	XIcon,
} from "@phosphor-icons/react/dist/ssr";

const STEP_ICONS = { reasoning: BrainIcon, tool: WrenchIcon } as const;

const BLOCK_LABELS = { input: "Input", output: "Output", error: "Error" };

function stepsCount(count: number): string {
	return `${count} ${count === 1 ? "step" : "steps"}`;
}

/* ------------------------------------------------------------------ context */

interface ProcessTarget {
	messageId: string;
	/** Takes the focus back when the panel closes. */
	trigger: HTMLElement | null;
}

interface ProcessContextValue {
	target: ProcessTarget | null;
	openProcess: (target: ProcessTarget) => void;
	closeProcess: () => void;
}

const ProcessContext = createContext<ProcessContextValue | null>(null);

/** Which answer's process the conversation shows beside it; one at a time. */
export function ProcessProvider({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<ProcessTarget | null>(null);
	const closeProcess = useCallback(() => {
		// The reader may have scrolled away from the line; giving its focus back must not scroll
		// them back to it.
		target?.trigger?.focus({ preventScroll: true });
		setTarget(null);
	}, [target]);
	const value = useMemo(
		() => ({ target, openProcess: setTarget, closeProcess }),
		[target, closeProcess],
	);
	return <ProcessContext value={value}>{children}</ProcessContext>;
}

const NO_PROCESS: ProcessContextValue = {
	target: null,
	openProcess: () => undefined,
	closeProcess: () => undefined,
};

/** Outside a provider (a transcript drawn on its own) the row still reads, it just opens nothing. */
function useProcess() {
	return useContext(ProcessContext) ?? NO_PROCESS;
}

/* ------------------------------------------------------------------ loader */

/**
 * The answer before anything of it arrives: the thinking glyph and phrases that take turns, on the
 * line where the steps will appear, so the first step takes over without anything moving.
 */
export function MessageLoading({
	words = WAITING_PHRASES,
}: {
	words?: readonly string[];
}) {
	return (
		<div
			className="flex w-full items-start py-1.5 text-base"
			data-role="waiting"
		>
			<ThinkingIndicator words={words} />
		</div>
	);
}

/* ------------------------------------------------------------------ row */

/**
 * One line above the answer for all of its steps: what the turn is doing while it runs, then how
 * many steps it took. It opens the steps beside the conversation instead of unfolding them here,
 * where a long run would bury the answer.
 */
export function ProcessRow({
	messageId,
	steps,
	isLive,
	isWriting,
	interrupted = false,
}: {
	messageId: string;
	/** The turn was stopped or failed: it did not finish its steps. */
	interrupted?: boolean;
	steps: readonly Step[];
	/** The turn is still running: more steps may come after the text. */
	isLive: boolean;
	/** And what arrives now is the answer's text. */
	isWriting: boolean;
}) {
	const { target, openProcess, closeProcess } = useProcess();
	const running = runningStep(steps);
	const last = steps.at(-1);
	let working: readonly string[] | null = null;
	if (running) {
		working = stepPhrases(running);
	} else if (isWriting) {
		working = ["Writing the answer"];
	} else if (isLive && last) {
		// Between two steps nothing runs yet; the last one keeps the line until the next arrives.
		working = stepPhrases(last);
	}
	const isOpen = target?.messageId === messageId;
	const doneLabel = interrupted
		? `Stopped after ${stepsCount(steps.length)}`
		: `Done in ${stepsCount(steps.length)}`;
	if (!last) {
		return null;
	}
	return (
		<Trace className="relative py-1.5">
			<button
				aria-expanded={isOpen}
				aria-label={working ? undefined : doneLabel}
				// Open reads like hover: the text comes forward. The invisible layer spans the whole
				// row, so the line answers anywhere across it without drawing anything.
				className="before:absolute before:inset-0 before:content-[''] aria-expanded:*:text-foreground"
				onClick={(event) =>
					isOpen
						? closeProcess()
						: openProcess({ messageId, trigger: event.currentTarget })
				}
				type="button"
			>
				<TraceLine className="text-base">
					{working ? (
						<ThinkingIndicator words={working} />
					) : (
						<TraceTitle>{doneLabel}</TraceTitle>
					)}
					<TraceIcon>
						<CaretRightIcon />
					</TraceIcon>
				</TraceLine>
			</button>
		</Trace>
	);
}

/* ------------------------------------------------------------------ steps */

const stepElementId = (key: string) => `process-step-${key}`;

/**
 * An answer's steps. The panel is opened to read them, so every step with detail starts open, and
 * stays as the reader leaves it once they fold or unfold it.
 */
export function ProcessTrace({ steps }: { steps: readonly Step[] }) {
	const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
	const runningKey = runningStep(steps)?.key;
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!runningKey) {
			return;
		}
		listRef.current
			?.querySelector(`#${CSS.escape(stepElementId(runningKey))}`)
			?.scrollIntoView({ block: "nearest" });
	}, [runningKey]);

	return (
		<Trace className="gap-3" ref={listRef}>
			{steps.map((step) => (
				<div className="min-w-0" id={stepElementId(step.key)} key={step.key}>
					{step.blocks.length > 0 ? (
						<TraceCollapsible
							onOpenChange={(open) =>
								setOpenSteps((current) => ({ ...current, [step.key]: open }))
							}
							open={openSteps[step.key] ?? true}
						>
							<TraceCollapsibleTrigger className="w-full">
								<StepLine step={step} />
							</TraceCollapsibleTrigger>
							<TraceCollapsibleContent>
								<StepBlocks
									blocks={step.blocks}
									streaming={step.status === "running"}
								/>
							</TraceCollapsibleContent>
						</TraceCollapsible>
					) : (
						<StepLine step={step} />
					)}
				</div>
			))}
		</Trace>
	);
}

function StepLine({ step }: { step: Step }) {
	const StepIcon = STEP_ICONS[step.kind];
	return (
		<TraceLine status={step.status === "done" ? undefined : step.status}>
			<TraceIcon>
				<StepIcon />
			</TraceIcon>
			<TraceTitle>{stepTitle(step)}</TraceTitle>
		</TraceLine>
	);
}

function StepBlocks({
	blocks,
	streaming,
}: {
	blocks: readonly StepBlock[];
	streaming: boolean;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-3 text-sm">
			{blocks.map((block) =>
				block.type === "markdown" ? (
					<Markdown
						compact
						key="markdown"
						streaming={streaming}
						text={block.text}
					/>
				) : (
					<figure className="flex min-w-0 flex-col gap-1.5" key={block.label}>
						<figcaption
							className={cn(
								"text-xs font-medium text-muted-foreground",
								block.label === "error" && "text-destructive-foreground",
							)}
						>
							{BLOCK_LABELS[block.label]}
						</figcaption>
						{/* The box sits outside the fade, so only the text fades at its edges. */}
						<ScrollArea
							className="h-auto rounded-lg bg-muted"
							scrollFade
							viewportClassName="max-h-72"
						>
							<pre className="min-w-0 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground">
								{block.text}
							</pre>
						</ScrollArea>
					</figure>
				),
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ panel */

/** Wide enough for the conversation and the panel side by side. */
const SIDE_PANEL_QUERY = "(min-width: 1024px)";
const PANEL_WIDTH = "w-80";

/** The shell's slot, once the page is in the browser (a portal needs a node; the server has none). */
function useSlot(id: string): HTMLElement | null {
	const [node, setNode] = useState<HTMLElement | null>(null);
	useEffect(() => setNode(document.querySelector<HTMLElement>(`#${id}`)), [id]);
	return node;
}

function useMediaQuery(query: string, serverValue: boolean): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() => window.matchMedia(query).matches,
		() => serverValue,
	);
}

/**
 * The process of the answer the reader opened: beside the conversation on a wide screen, in a
 * bottom sheet on a narrow one. It follows the message as it streams.
 */
export function ProcessPanel({
	messages,
}: {
	messages: readonly PlaygroundMessage[];
}) {
	const { target, closeProcess } = useProcess();
	const isSide = useMediaQuery(SIDE_PANEL_QUERY, true);
	// The side panel keeps the answer it showed while it slides closed.
	const [shown, setShown] = useState(target);
	if (target && target !== shown) {
		setShown(target);
	}
	const message = shown
		? messages.find((candidate) => candidate.id === shown.messageId)
		: undefined;
	const isOpen = Boolean(target && message);
	const steps = useMemo(() => {
		const state = message?.metadata?.state;
		return settleSteps(
			stepsOf(message?.parts ?? []),
			state === "streaming",
			state === "stopped" || state === "failed",
		);
	}, [message]);
	const bodyRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLElement>(null);
	const slot = useSlot(SIDE_PANEL_SLOT);
	const openedId = isOpen ? target?.messageId : undefined;

	// Each answer opens at its first step, not where the previous one was left.
	useEffect(() => {
		if (openedId) {
			bodyRef.current?.scrollIntoView({ block: "start" });
		}
	}, [openedId]);

	// The side panel takes the focus when it opens, so it can be read or closed from the keyboard.
	// The panel itself, not its close button: a ring around the × on every open reads as an error.
	useEffect(() => {
		if (target) {
			panelRef.current?.focus({ preventScroll: true });
		}
	}, [target]);

	const description = stepsCount(steps.length);
	// Keyed by the answer: a step folded in one answer must not fold the step at the same place in
	// the next one opened.
	const trace = <ProcessTrace key={message?.id} steps={steps} />;

	if (!isSide) {
		return (
			<Sheet
				onOpenChange={(open) => {
					if (!open) {
						closeProcess();
					}
				}}
				open={isOpen}
			>
				<SheetPopup className="h-[85dvh] max-h-[85dvh]" side="bottom">
					<SheetHeader>
						<SheetTitle>Process</SheetTitle>
						<SheetDescription>{description}</SheetDescription>
					</SheetHeader>
					<ScrollArea className="min-h-0 flex-1" scrollFade>
						<div className="px-6 pt-1 pb-8" ref={bodyRef}>
							{trace}
						</div>
					</ScrollArea>
				</SheetPopup>
			</Sheet>
		);
	}

	// The window's right edge, beside the shell's main column: opens and closes like the sidebar on
	// the other side, its width easing while the content keeps its own, so nothing reflows.
	if (!slot) {
		return null;
	}
	return createPortal(
		<aside
			aria-labelledby="process-panel-title"
			className={cn(
				"hidden h-dvh shrink-0 overflow-hidden bg-background transition-sidebar outline-none lg:block",
				isOpen ? `${PANEL_WIDTH} border-l` : "w-0",
			)}
			inert={!isOpen}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					closeProcess();
				}
			}}
			ref={panelRef}
			tabIndex={-1}
		>
			{/* The sidebar's anatomy: a header row over a hairline, then a scroll area to the edge. */}
			<div className={cn("flex h-full flex-col gap-3 px-2 py-3", PANEL_WIDTH)}>
				<header className="flex shrink-0 items-center justify-between gap-2 border-b pb-3 *:h-10">
					<div className="flex min-w-0 items-center gap-2 px-2">
						<h2 className="text-sm font-medium" id="process-panel-title">
							Process
						</h2>
						<span className="text-xs text-muted-foreground tabular-nums">
							{description}
						</span>
					</div>
					<Button
						aria-label="Close the process"
						className="size-10 shrink-0 text-muted-foreground hover:text-foreground"
						mode="icon"
						onClick={closeProcess}
						variant="ghost"
					>
						<XIcon aria-hidden />
					</Button>
				</header>
				<ScrollArea
					className="-mx-2 min-h-0 w-auto flex-1"
					scrollbar="edge"
					scrollFade
				>
					<div className="px-4 pt-1 pb-4" ref={bodyRef}>
						{trace}
					</div>
				</ScrollArea>
			</div>
		</aside>,
		slot,
	);
}
