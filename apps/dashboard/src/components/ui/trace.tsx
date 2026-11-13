"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { CaretRightIcon } from "@phosphor-icons/react/dist/ssr";
import { cn } from "#/shared/lib/classes";
import type * as React from "react";

/**
 * A list of steps: one line each, with an icon, a title that shimmers while its step runs, an
 * optional description, and a collapsible body for the detail. A line can sit inside a button.
 */
export function Trace({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex w-full min-w-0 flex-col gap-2 *:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-left *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:outline-2 *:has-[>[data-slot=trace-line]]:focus-visible:outline-offset-2 *:has-[>[data-slot=trace-line]]:focus-visible:outline-ring",
				className,
			)}
			data-slot="trace"
			{...props}
		/>
	);
}

export function TraceLine({
	className,
	status,
	...props
}: React.ComponentProps<"span"> & {
	/** Unset is a finished step. */
	status?: "running" | "error" | "pending" | undefined;
}) {
	return (
		<span
			className={cn(
				"flex w-fit max-w-full min-w-0 items-center gap-2 text-sm text-muted-foreground transition-colors in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground data-[status=error]:text-destructive-foreground data-[status=error]:in-[a:hover,button:hover]:text-destructive-foreground data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer",
				className,
			)}
			data-slot="trace-line"
			data-status={status}
			{...props}
		/>
	);
}

export function TraceIcon({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [[data-slot=trace-title]~&]:-ml-1",
				className,
			)}
			data-slot="trace-icon"
			{...props}
		/>
	);
}

export function TraceTitle({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn("min-w-0 truncate motion-reduce:shimmer-none", className)}
			data-slot="trace-title"
			{...props}
		/>
	);
}

export function TraceDescription({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"shrink-0 text-muted-foreground/70 tabular-nums",
				className,
			)}
			data-slot="trace-description"
			{...props}
		/>
	);
}

export function TraceCollapsible({
	className,
	...props
}: CollapsiblePrimitive.Root.Props) {
	return (
		<CollapsiblePrimitive.Root
			className={cn("flex w-full min-w-0 flex-col", className)}
			data-slot="trace-collapsible"
			{...props}
		/>
	);
}

export function TraceCollapsibleTrigger({
	className,
	children,
	...props
}: CollapsiblePrimitive.Trigger.Props) {
	return (
		<CollapsiblePrimitive.Trigger
			className={cn(
				"group/trace-collapsible-trigger flex min-h-9 w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-md text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-[[data-status=error]]:text-destructive-foreground",
				className,
			)}
			data-slot="trace-collapsible-trigger"
			{...props}
		>
			{children}
			<TraceIcon className="transition-transform group-aria-expanded/trace-collapsible-trigger:rotate-90">
				<CaretRightIcon />
			</TraceIcon>
		</CollapsiblePrimitive.Trigger>
	);
}

export function TraceCollapsibleContent({
	className,
	children,
	...props
}: CollapsiblePrimitive.Panel.Props) {
	return (
		<CollapsiblePrimitive.Panel
			className="h-(--collapsible-panel-height) min-w-0 overflow-hidden transition-[height] duration-200 data-ending-style:h-0 data-starting-style:h-0"
			data-slot="trace-collapsible-content"
			{...props}
		>
			<div
				className={cn(
					"mt-2 mb-1 ml-[calc(--spacing(2)-1px)] min-w-0 border-l pr-1 pl-4 leading-relaxed wrap-break-word text-muted-foreground",
					className,
				)}
				data-slot="trace-collapsible-content-inner"
			>
				{children}
			</div>
		</CollapsiblePrimitive.Panel>
	);
}
