"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { cn } from "#/shared/lib/classes";
import type React from "react";

export function ScrollArea({
	className,
	children,
	scrollFade = false,
	scrollbarGutter = false,
	scrollbar = "inset",
	viewportClassName,
	viewportProps,
	...props
}: ScrollAreaPrimitive.Root.Props & {
	/** Props for the scrolling element (a ref to follow its scroll, `onScroll`, data attributes). */
	viewportProps?: Omit<
		ScrollAreaPrimitive.Viewport.Props,
		"className" | "children"
	> &
		Record<`data-${string}`, string | undefined>;
	/** Classes for the scrolling element itself, e.g. a `max-h-*` that bounds a growing block. */
	viewportClassName?: string;
	scrollFade?: boolean;
	scrollbarGutter?: boolean;
	/**
	 * `edge`: a thinner vertical bar against the area's edge, for areas that reach a border.
	 * `popup`: a 2px thumb inside a popup's 4px padding, against its border, clear of the options
	 *   and of the rounded corners — the padding stays the same on every side.
	 */
	scrollbar?: "inset" | "edge" | "popup";
}): React.ReactElement {
	return (
		<ScrollAreaPrimitive.Root
			className={cn("size-full min-h-0", className)}
			{...props}
		>
			<ScrollAreaPrimitive.Viewport
				className={cn(
					"transition-shadows h-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background data-has-overflow-x:overscroll-x-contain data-has-overflow-y:overscroll-y-contain",
					scrollFade &&
						"mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] [--fade-size:1.5rem]",
					scrollbarGutter &&
						cn(
							"[scrollbar-gutter:stable] data-has-overflow-x:pb-3.5",
							scrollbar === "popup"
								? "data-has-overflow-y:pe-2"
								: "data-has-overflow-y:pe-2.5",
						),
					viewportClassName,
				)}
				data-slot="scroll-area-viewport"
				{...viewportProps}
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar
				className={cn(
					scrollbar === "edge" &&
						"data-[orientation=vertical]:my-1 data-[orientation=vertical]:ms-0 data-[orientation=vertical]:me-px data-[orientation=vertical]:w-1",
					scrollbar === "popup" &&
						"data-[orientation=vertical]:my-2 data-[orientation=vertical]:ms-0 data-[orientation=vertical]:me-px data-[orientation=vertical]:w-0.5 *:data-[slot=scroll-area-thumb]:bg-foreground/24 data-hovering:*:data-[slot=scroll-area-thumb]:bg-foreground/40",
				)}
				orientation="vertical"
			/>
			<ScrollBar orientation="horizontal" />
			<ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
		</ScrollAreaPrimitive.Root>
	);
}

export function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: ScrollAreaPrimitive.Scrollbar.Props): React.ReactElement {
	return (
		<ScrollAreaPrimitive.Scrollbar
			className={cn(
				// Above the content it scrolls (a table row's stretched link must not take its clicks).
				// The horizontal bar is a 12px target against the bottom edge with a 6px thumb inside,
				// 8px while hovered: easy to grab, still quiet.
				"z-10 flex opacity-0 transition-[opacity,padding] delay-300 data-hovering:opacity-100 data-hovering:delay-0 data-hovering:duration-100 data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-100 data-[orientation=horizontal]:mx-1.5 data-[orientation=horizontal]:mb-px data-[orientation=horizontal]:h-3 data-[orientation=horizontal]:flex-col data-[orientation=horizontal]:py-[3px] data-[orientation=horizontal]:data-hovering:py-[2px] data-[orientation=vertical]:m-1 data-[orientation=vertical]:w-1.5",
				className,
			)}
			data-slot="scroll-area-scrollbar"
			orientation={orientation}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb
				className="relative flex-1 rounded-full bg-foreground/20"
				data-slot="scroll-area-thumb"
			/>
		</ScrollAreaPrimitive.Scrollbar>
	);
}

export { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
