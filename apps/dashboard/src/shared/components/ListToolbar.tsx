"use client";

import { Button } from "#/components/ui/button";
import { cn } from "#/shared/lib/classes";
import type { ReactNode } from "react";

import {
	SlidersHorizontalIcon as SlidersHorizontal,
	ArrowsDownUpIcon as ArrowDownUp,
	FunnelSimpleIcon as ListFilter,
} from "@phosphor-icons/react/dist/ssr";

import {
	SheetTrigger,
	SheetHeader,
	SheetFooter,
	SheetPopup,
	SheetTitle,
	SheetClose,
	SheetPanel,
	Sheet,
} from "#/components/ui/sheet";

import {
	SelectTrigger,
	SelectPopup,
	SelectValue,
	SelectItem,
	Select,
} from "#/components/ui/primitives/select";

export interface ListOption {
	value: string;
	label: string;
}

/** A segment select's icon, for a searchable select that filters the same list beside it. */
export function SegmentIcon() {
	return <ListFilter aria-hidden="true" />;
}

/**
 * One choice of a list — its segments (*All keys, Enabled, Disabled*) or its order — as Billete's:
 * a select with an icon. The toolbar sizes it (see `ListToolbar`); its value truncates to one line.
 * Choosing the first option is the list's default.
 */
export function ListSelect({
	kind,
	label,
	options,
	value,
	onValueChange,
	className,
}: {
	/** `segment` shows the filter icon, `sort` the arrows. */
	kind: "segment" | "sort";
	label: string;
	options: readonly ListOption[];
	value: string;
	onValueChange: (value: string) => void;
	className?: string;
}) {
	const Icon = kind === "segment" ? ListFilter : ArrowDownUp;
	return (
		<Select
			items={options}
			modal={false}
			onValueChange={(next) => {
				if (typeof next === "string") {
					onValueChange(next);
				}
			}}
			value={value}
		>
			<SelectTrigger
				aria-label={label}
				className={cn("min-w-0 flex-1", className)}
			>
				<Icon aria-hidden="true" />
				<SelectValue />
			</SelectTrigger>
			<SelectPopup>
				{options.map((option) => (
					<SelectItem key={option.value} value={option.value}>
						{option.label}
					</SelectItem>
				))}
			</SelectPopup>
		</Select>
	);
}

/**
 * Phones have no room for the selects beside the search: *Filters* holds them in a panel from the
 * bottom, as Billete's does. Each applies at once, as in the toolbar.
 */
function FiltersSheet({ children }: { children: ReactNode }) {
	return (
		<Sheet>
			<SheetTrigger
				render={<Button className="@min-[40rem]:hidden" variant="secondary" />}
			>
				<SlidersHorizontal aria-hidden="true" />
				Filters
			</SheetTrigger>
			<SheetPopup side="bottom">
				<SheetHeader>
					<SheetTitle>Filters</SheetTitle>
				</SheetHeader>
				<SheetPanel>
					<div className="flex flex-col gap-3 *:w-full *:flex-none">
						{children}
					</div>
				</SheetPanel>
				<SheetFooter>
					<SheetClose render={<Button />}>Show results</SheetClose>
				</SheetFooter>
			</SheetPopup>
		</Sheet>
	);
}

/**
 * Above a list, Billete's: its segments and order on one side; its search, filters and actions on
 * the other. Both share a row when the toolbar (not the window: the sidebar takes part of it) fits
 * them, and wrap otherwise. Under 40rem the selects move into *Filters*, beside the search.
 *
 * The toolbar always spans the list's width: each side grows into its row, every select from 9rem
 * and every search from 12rem (`SEARCH_WIDTH`), while buttons keep their own width. A row too narrow
 * for its controls wraps them rather than squeezing them, and values truncate to one line.
 */
export function ListToolbar({
	selects,
	controls,
}: {
	selects?: ReactNode;
	controls?: ReactNode;
}) {
	return (
		<div className="@container flex flex-col gap-3" data-slot="list-toolbar">
			<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
				{selects ? (
					<div className="hidden min-w-0 flex-[1_1_auto] flex-wrap items-center gap-2 *:min-w-0 *:flex-[1_1_9rem] @min-[40rem]:flex">
						{selects}
					</div>
				) : null}
				{controls || selects ? (
					<div className="flex w-full min-w-0 flex-[1_1_auto] flex-wrap items-center gap-2 @min-[40rem]:w-auto">
						{controls}
						{selects ? <FiltersSheet>{selects}</FiltersSheet> : null}
					</div>
				) : null}
			</div>
		</div>
	);
}
