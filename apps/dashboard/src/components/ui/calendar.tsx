"use client";

import {
	CaretLeftIcon as ChevronLeft,
	CaretRightIcon as ChevronRight,
} from "@phosphor-icons/react/dist/ssr";
import { DayPicker } from "react-day-picker";
import { cn } from "#/shared/lib/classes";
import type * as React from "react";

function CalendarChevron({
	orientation,
	className,
}: {
	orientation?: "left" | "right" | "up" | "down";
	className?: string;
}) {
	return orientation === "left" ? (
		<ChevronLeft aria-hidden className={cn("size-4", className)} />
	) : (
		<ChevronRight aria-hidden className={cn("size-4", className)} />
	);
}

/**
 * coss UI's calendar: react-day-picker styled with the dashboard's tokens. Every day is a 36px
 * target, the same height as the controls around it; a range reads as one band with rounded ends.
 */
export function Calendar({
	className,
	classNames,
	showOutsideDays = true,
	...props
}: React.ComponentProps<typeof DayPicker>) {
	return (
		<DayPicker
			className={cn("w-fit p-1", className)}
			classNames={{
				months: "relative flex flex-col gap-4 sm:flex-row",
				month: "flex w-full flex-col gap-2",
				month_caption:
					"flex h-9 items-center justify-center px-10 font-medium text-sm",
				caption_label: "text-sm",
				nav: "absolute inset-x-0 top-0 flex items-center justify-between",
				button_previous:
					"inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
				button_next:
					"inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
				month_grid: "w-full border-collapse",
				weekdays: "flex",
				weekday:
					"flex size-9 items-center justify-center font-normal text-muted-foreground text-xs",
				week: "mt-0.5 flex w-full",
				day: "group/day relative size-9 p-0 text-center text-sm data-[selected]:bg-accent [&.rdp-range_start]:rounded-s-lg [&.rdp-range_end]:rounded-e-lg [&.rdp-range_middle]:rounded-none data-[selected]:not-[.rdp-range_middle]:rounded-lg first:data-[selected]:rounded-s-lg last:data-[selected]:rounded-e-lg",
				day_button:
					"inline-flex size-9 cursor-pointer items-center justify-center rounded-lg tabular-nums outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring group-[.rdp-range_middle]/day:hover:bg-transparent group-[.rdp-range_start]/day:bg-primary group-[.rdp-range_start]/day:text-primary-foreground group-[.rdp-range_end]/day:bg-primary group-[.rdp-range_end]/day:text-primary-foreground group-data-[selected]/day:not-group-[.rdp-range_middle]/day:bg-primary group-data-[selected]/day:not-group-[.rdp-range_middle]/day:text-primary-foreground",
				range_start: "rdp-range_start",
				range_middle: "rdp-range_middle",
				range_end: "rdp-range_end",
				today: "font-semibold [&:not([data-selected])>button]:text-primary",
				outside: "text-muted-foreground/60",
				disabled: "pointer-events-none text-muted-foreground/40",
				hidden: "invisible",
				...classNames,
			}}
			components={{ Chevron: CalendarChevron }}
			showOutsideDays={showOutsideDays}
			{...props}
		/>
	);
}
