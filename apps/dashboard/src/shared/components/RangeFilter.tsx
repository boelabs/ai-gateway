"use client";

import { PopoverRoot, PopoverTrigger, Popover } from "#/components/ui/popover";
import {
	CalendarBlankIcon as IconCalendar,
	CaretDownIcon as ChevronDown,
} from "@phosphor-icons/react/dist/ssr";
import type { Query } from "#/shared/lib/useSearchWriter.ts";
import { Calendar } from "#/components/ui/calendar";
import { Button } from "#/components/ui/button";
import type { DateRange } from "react-day-picker";
import { GhostSkeleton } from "#/shared/components/Skeleton.tsx";
import { cn } from "#/shared/lib/classes";
import { useState } from "react";

import {
	customRangeIsValid,
	type RangeSearch,
	MAX_RANGE_DAYS,
	type RangeKey,
	RANGES,
	DAY,
} from "#/shared/lib/range.ts";

const day = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});

function dayLabel(iso: string): string {
	const parsed = Date.parse(`${iso}T00:00:00Z`);
	return Number.isFinite(parsed) ? day.format(parsed) : iso;
}

function spanLabel(from: string, to: string): string {
	return from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
}

function toIso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function fromIso(iso: string | undefined): Date | undefined {
	if (!iso) {
		return;
	}
	const parsed = Date.parse(`${iso}T00:00:00Z`);
	return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

/**
 * The time range control, shared by every page that has one: one button that says which range is
 * in force, opening coss's date picker with presets — the periods on the left, a calendar for
 * custom dates on the right.
 *
 * A preset applies the moment it is picked. Custom dates apply on *Apply*, because a range picked
 * one end at a time is not a range anybody asked for until both ends are there. Nothing is held
 * here beyond the draft: the URL is what remembers, so a range survives a reload and a link.
 */
export function RangeFilter({
	periods,
	value,
	fallback,
	onChange,
	label,
}: {
	periods: readonly RangeKey[];
	value: RangeSearch;
	/** The period in force when the URL carries none. */
	fallback: RangeKey;
	/**
	 * Typed as the writer's patch shape, not as `RangeSearch`: what comes back is on its way
	 * into the query string, and `Query` is the only shape `useSearchWriter` accepts.
	 */
	onChange: (patch: Query) => void;
	/** A visible prefix inside the trigger ("Period"); the trigger is labelled either way. */
	label?: string;
}) {
	const period = value.period ?? fallback;
	const now = new Date();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<DateRange | undefined>(() => {
		const from = fromIso(value.from);
		return from ? { from, to: fromIso(value.to) } : undefined;
	});
	const [month, setMonth] = useState<Date>(
		() => fromIso(value.to) ?? new Date(),
	);
	const from = draft?.from ? toIso(draft.from) : undefined;
	const to = draft?.to ? toIso(draft.to) : from;
	const valid = customRangeIsValid(from, to);
	const presets = periods.filter((key) => key !== "custom");
	const allowsCustom = periods.includes("custom");
	const current =
		period === "custom" && value.from && value.to
			? spanLabel(value.from, value.to)
			: RANGES[period];

	return (
		<PopoverRoot onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				aria-label={`${label ?? "Time range"}: ${current}`}
				render={<Button className="justify-start" variant="secondary" />}
			>
				<IconCalendar aria-hidden />
				{label ? (
					<span className="font-normal text-muted-foreground">{label}</span>
				) : null}
				<span className="tabular-nums">{current}</span>
				<ChevronDown aria-hidden className="ms-auto -me-1 opacity-60" />
			</PopoverTrigger>
			<Popover
				aria-label="Time range"
				className="w-auto max-w-[calc(100vw-2rem)] p-1"
				positionerProps={{ align: "start", sideOffset: 6 }}
			>
				<div className="flex max-sm:flex-col">
					<div className="flex flex-col gap-0.5 p-1 max-sm:order-1 max-sm:border-t sm:min-w-36 sm:border-e sm:pe-2">
						{presets.map((key) => (
							<Button
								aria-pressed={period === key}
								className={cn(
									"w-full justify-start",
									period === key && "bg-accent",
								)}
								key={key}
								onClick={() => {
									onChange({ period: key, from: undefined, to: undefined });
									setOpen(false);
								}}
								size="sm"
								variant="ghost"
							>
								{RANGES[key]}
							</Button>
						))}
					</div>
					{allowsCustom ? (
						<div className="flex flex-col gap-2 p-1 sm:ps-2">
							<Calendar
								disabled={[
									{ after: now },
									...(draft?.from && !draft.to
										? [
												{
													before: new Date(
														draft.from.getTime() - (MAX_RANGE_DAYS - 1) * DAY,
													),
												},
												{
													after: new Date(
														draft.from.getTime() + (MAX_RANGE_DAYS - 1) * DAY,
													),
												},
											]
										: []),
								]}
								mode="range"
								month={month}
								onMonthChange={setMonth}
								onSelect={setDraft}
								selected={draft}
								timeZone="UTC"
							/>
							<div className="flex items-center justify-between gap-3 border-t px-1 pt-2">
								<span className="text-xs text-muted-foreground">
									{from
										? `${spanLabel(from, to ?? from)} · UTC`
										: `Up to ${MAX_RANGE_DAYS} days`}
								</span>
								<Button
									disabled={!valid}
									onClick={() => {
										if (from && to && valid) {
											onChange({ period: "custom", from, to });
											setOpen(false);
										}
									}}
									size="sm"
								>
									Apply
								</Button>
							</div>
						</div>
					) : null}
				</div>
			</Popover>
		</PopoverRoot>
	);
}

/**
 * The trigger as a ghost, for a prerendered shell: `RangeFilter` reads today's date, which the
 * shell has no value for, so the fallback draws the default period's button without it.
 */
export function RangeFilterSkeleton({
	period,
	label,
}: {
	period: RangeKey;
	label?: string;
}) {
	return (
		<GhostSkeleton>
			<Button className="justify-start" variant="secondary">
				<IconCalendar aria-hidden />
				{label ? <span className="font-normal">{label}</span> : null}
				<span>{RANGES[period]}</span>
				<ChevronDown aria-hidden className="ms-auto -me-1" />
			</Button>
		</GhostSkeleton>
	);
}
