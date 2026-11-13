"use client";

import { Button } from "#/components/ui/button";

import {
	CaretRightIcon as IconChevronRight,
	CaretLeftIcon as IconChevronLeft,
} from "@phosphor-icons/react/dist/ssr";

const count = new Intl.NumberFormat("en-US");

/**
 * Server-side paging, because these tables are windows onto tables that grow without bound: a
 * gateway with a month of traffic has more operations than any page should hold, and "showing 100 of
 * 42.000" without a way forward is a dead end rather than a limit.
 *
 * The offset lives in the URL at every call site, so a page of results can be linked and reloaded.
 */
export function Pagination({
	limit,
	offset,
	total,
	onOffsetChange,
	label,
	alwaysVisible = false,
	totalIsLowerBound = false,
}: {
	limit: number;
	offset: number;
	total: number;
	/** The gateway stopped counting at `total`: there are at least that many, so paging goes on. */
	totalIsLowerBound?: boolean;
	onOffsetChange: (offset: number) => void;
	/** Plural noun for the rows being paged, e.g. "keys". */
	label: string;
	alwaysVisible?: boolean;
}) {
	if (!alwaysVisible && total <= limit && offset === 0) {
		return null;
	}
	const first =
		total === 0 || (offset >= total && !totalIsLowerBound) ? 0 : offset + 1;
	let last = 0;
	if (totalIsLowerBound) {
		last = offset + limit;
	} else if (offset < total) {
		last = Math.min(offset + limit, total);
	}
	return (
		<nav
			aria-label={`${label} pages`}
			className="flex flex-wrap items-center justify-between gap-3 pt-4"
		>
			<p className="text-xs text-fg-muted tabular-nums">
				{count.format(first)}–{count.format(last)} of {count.format(total)}
				{totalIsLowerBound ? "+" : ""} {label}
			</p>
			<div className="flex items-center gap-2">
				<Button
					disabled={offset === 0}
					onClick={() => onOffsetChange(Math.max(0, offset - limit))}
					size="sm"
					variant="secondary"
				>
					<IconChevronLeft aria-hidden className="mr-1 size-4" />
					Previous
				</Button>
				<Button
					disabled={!totalIsLowerBound && offset + limit >= total}
					onClick={() => onOffsetChange(offset + limit)}
					size="sm"
					variant="secondary"
				>
					Next
					<IconChevronRight aria-hidden className="ml-1 size-4" />
				</Button>
			</div>
		</nav>
	);
}
