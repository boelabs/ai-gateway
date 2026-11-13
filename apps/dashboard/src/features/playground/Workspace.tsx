"use client";

import { ScrollArea } from "#/components/ui/primitives/scroll-area";
import type { ReactNode, RefObject } from "react";
import { ErrorNote } from "#/components/ui/page";
import { useEffect } from "react";

/**
 * The frame a capability's session is laid out in.
 *
 * The chat defined this shape and every other capability keeps it: a transcript that grows upward,
 * and a composer that sits in the middle of an empty session and at the foot of a busy one. Moving
 * between capabilities then moves the work, not the furniture.
 */
export function Workspace({
	scroll,
	empty,
	transcript,
	composer,
	error,
	title = "Playground",
	children,
}: {
	scroll: RefObject<HTMLDivElement | null>;
	empty: boolean;
	transcript: ReactNode;
	composer: ReactNode;
	/** What this workspace itself rejected — a bad attachment, an empty prompt. */
	error?: string;
	title?: string;
	/** Anything that renders outside the flow, such as the capability's settings dialog. */
	children?: ReactNode;
}) {
	/**
	 * The height the last turn reserves below itself, so a new answer starts at the top of the view
	 * instead of creeping up from the bottom. The chat sets the same variable; every transcript in
	 * the playground is laid out against it.
	 */
	useEffect(() => {
		const area = scroll.current;
		if (!area) {
			return;
		}
		const resize = new ResizeObserver(() => {
			area.style.setProperty("--transcript-height", `${area.clientHeight}px`);
		});
		resize.observe(area);
		return () => resize.disconnect();
	}, [scroll]);

	return (
		<div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
			{/* The whole column scrolls, so the bar sits at its edge. */}
			<ScrollArea
				className="min-h-0 flex-1"
				scrollbar="edge"
				viewportClassName="pt-6"
				viewportProps={{ ref: scroll }}
			>
				{empty ? (
					<div className="flex h-full items-center justify-center px-4 pb-8 sm:hidden">
						<h2 className="text-center text-2xl font-medium tracking-tight">
							{title}
						</h2>
					</div>
				) : (
					<div className="mx-auto flex w-full flex-col gap-10 pb-8 sm:max-w-2xl xl:max-w-3xl">
						{transcript}
					</div>
				)}
			</ScrollArea>
			<div
				className={`relative mx-auto w-full shrink-0 px-2 pt-3 pb-3 sm:max-w-[calc(var(--container-2xl)+3rem)] sm:px-6 xl:max-w-[calc(var(--container-3xl)+3rem)] ${
					empty
						? "sm:absolute sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2"
						: ""
				}`}
			>
				{empty ? (
					<h2 className="mb-6 hidden text-center text-3xl font-medium tracking-tight sm:block">
						{title}
					</h2>
				) : null}
				{error ? (
					<div className="mb-2 px-2 sm:px-0">
						<ErrorNote width="fit-content">{error}</ErrorNote>
					</div>
				) : null}
				{composer}
			</div>
			{children}
		</div>
	);
}
