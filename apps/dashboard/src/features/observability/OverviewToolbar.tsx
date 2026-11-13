"use client";

import { OVERVIEW_PERIODS, DEFAULT_PERIOD } from "./overviewFilters.ts";
import {
	RangeFilterSkeleton,
	RangeFilter,
} from "#/shared/components/RangeFilter.tsx";
import { useSearchWriter } from "#/shared/lib/useSearchWriter.ts";
import type { OverviewFilters } from "./overviewFilters.ts";

/**
 * The overview's range control, Billete's: the action of the "Summary" section above the tiles.
 *
 * It is rendered by the page rather than inside `Overview`: the window is what everything below is
 * about, and it stays on screen while the numbers underneath stream in. The wrapper keeps the
 * period and its custom-dates button together on the right of the heading.
 */
export function OverviewToolbar({ filters }: { filters: OverviewFilters }) {
	const { filter } = useSearchWriter(filters);
	return (
		<div className="flex flex-wrap items-center justify-end gap-2">
			<RangeFilter
				fallback={DEFAULT_PERIOD}
				onChange={(patch) => filter(patch)}
				periods={OVERVIEW_PERIODS}
				value={filters}
			/>
		</div>
	);
}

/** The control above while the URL it reads streams in: the default period, as a ghost. */
export function OverviewToolbarSkeleton() {
	return <RangeFilterSkeleton period={DEFAULT_PERIOD} />;
}
