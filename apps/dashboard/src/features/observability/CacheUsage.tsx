"use client";

import { ToggleGroup } from "#/components/ui/toggle-group";
import { ChartTooltip } from "#/components/ui/chart";
import { Panel } from "#/shared/components/Panel";
import { Toggle } from "#/components/ui/toggle";
import { compact } from "./metrics-data";
import { cn } from "#/shared/lib/classes";
import { useState } from "react";

import {
	type CacheUsage as Usage,
	cacheReuseRate,
	tokenCount,
} from "./cache-usage";

const percent = new Intl.NumberFormat("en-US", {
	style: "percent",
	maximumFractionDigits: 1,
});

/** Input rows of one breakdown: a model, a key… with its own cache counts. */
export interface CacheBreakdown {
	id: string;
	/** The toggle's label: "By model". */
	label: string;
	rows: readonly (Usage & { key: string | null })[];
	/** How a row's key reads; defaults to the key itself. */
	name?: (key: string | null) => string;
}

const TOP = 6;

/** The three disjoint parts of the input, in the order they stack from the left. */
const PARTS = [
	{ key: "cached", label: "Cached", color: "var(--chart-input-cached)" },
	{ key: "uncached", label: "Uncached", color: "var(--chart-input)" },
	{
		key: "unclassified",
		label: "Unclassified",
		color: "var(--chart-input-unclassified)",
	},
] as const;

interface Row {
	name: string;
	full: string;
	cached: number;
	uncached: number;
	unclassified: number;
	total: number;
	reuse: number | null;
}

function toRow(usage: Usage, name: string, full: string): Row {
	const cached = usage.cacheReadTokens ?? 0;
	const uncached = usage.uncachedInputTokens ?? 0;
	const unclassified = usage.cacheUnreportedInputTokens ?? 0;
	return {
		name,
		full,
		cached,
		uncached,
		unclassified,
		total: cached + uncached + unclassified,
		reuse: cacheReuseRate(usage),
	};
}

/**
 * Where the input went and how much of it the prompt cache served: one horizontal bar per model or
 * key, split cached | uncached, longest first. The headline is the overall reuse rate; the legend
 * carries the totals. Missing measurements read as —, never as zero.
 */
export function CacheUsage({
	usage,
	records,
	upstream = false,
	breakdowns = [],
}: {
	usage: Usage;
	records: number;
	upstream?: boolean;
	/** Per-model / per-key views of the same input, switched from the panel's header. */
	breakdowns?: readonly CacheBreakdown[];
}) {
	const [view, setView] = useState(breakdowns[0]?.id);
	const breakdown = breakdowns.find((entry) => entry.id === view);
	const reuse = cacheReuseRate(usage);
	const unit = upstream ? "attempts" : "requests";
	const overall = toRow(usage, "All", "All input");
	const measured =
		usage.cacheReadTokens != null || usage.uncachedInputTokens != null;
	const name = breakdown?.name ?? ((key: string | null) => key ?? "—");
	let ranked: Row[] = [];
	if (breakdown) {
		ranked = breakdown.rows
			.map((row) => toRow(row, name(row.key), row.key ?? "—"))
			.filter((row) => row.total > 0)
			.sort((a, b) => b.total - a.total);
	} else if (overall.total > 0) {
		ranked = [overall];
	}
	const rows = ranked.slice(0, TOP);
	const hidden = ranked.length - rows.length;
	/** Unclassified earns a legend entry and a segment only when some input is in it. */
	const parts = PARTS.filter(
		(part) => part.key !== "unclassified" || overall.unclassified > 0,
	);

	return (
		<Panel
			action={
				breakdowns.length > 1 ? (
					<ToggleGroup
						aria-label="Break input down"
						onValueChange={(values) => {
							if (values[0]) {
								setView(values[0]);
							}
						}}
						value={view ? [view] : []}
					>
						{breakdowns.map((entry) => (
							<Toggle key={entry.id} size="xs" value={entry.id} variant="ghost">
								{entry.label}
							</Toggle>
						))}
					</ToggleGroup>
				) : null
			}
			description={
				upstream
					? "Prompt cache across every deployment attempt, retries included."
					: "Prompt cache across recorded requests."
			}
			title={<h2>{upstream ? "Provider cache" : "Input tokens"}</h2>}
		>
			<div className="flex flex-col gap-5">
				<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
					<p className="flex items-baseline gap-2">
						<span className="text-2xl font-semibold tracking-tight tabular-nums">
							{reuse === null ? "—" : percent.format(reuse)}
						</span>
						<span className="text-sm text-muted-foreground">
							cache reuse of{" "}
							<span
								className="font-medium text-foreground tabular-nums"
								title={tokenCount(overall.total)}
							>
								{measured ? compact.format(overall.total) : "—"}
							</span>{" "}
							input tokens
						</span>
					</p>
					<ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
						{parts.map((part) => (
							<li className="flex items-center gap-2" key={part.key}>
								<span
									aria-hidden
									className="size-2.5 rounded-sm"
									style={{ background: part.color }}
								/>
								<span className="text-muted-foreground">{part.label}</span>
								<span
									className="font-medium tabular-nums"
									title={tokenCount(overall[part.key])}
								>
									{measured ? compact.format(overall[part.key]) : "—"}
								</span>
							</li>
						))}
					</ul>
				</div>

				{rows.length > 0 ? (
					<BreakdownBars named={Boolean(breakdown)} parts={parts} rows={rows} />
				) : (
					<p className="py-6 text-center text-sm text-muted-foreground">
						No input recorded in this period.
					</p>
				)}

				<p className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground tabular-nums">
					{hidden > 0 ? <span>{hidden} more not shown</span> : null}
					<span>
						Cache writes{" "}
						<span className="font-medium text-foreground">
							{tokenCount(usage.cacheWriteTokens)}
						</span>
					</span>
					<span>
						Reads reported by{" "}
						<span className="font-medium text-foreground">
							{tokenCount(usage.cacheReadReported)}
						</span>{" "}
						of {tokenCount(records)} {unit}
					</span>
				</p>
			</div>
		</Panel>
	);
}

/**
 * One horizontal bar per row, its parts side by side, all on one scale: the longest row spans the
 * track and the others are in proportion. HTML in percentages (the Rosen way), so the bars need no
 * measuring and their ends stay round. The total follows each bar; the parts are in the tooltip.
 */
function BreakdownBars({
	rows,
	parts,
	named,
}: {
	rows: readonly Row[];
	parts: readonly (typeof PARTS)[number][];
	/** One overall bar names nothing: the label column would only reserve a gutter. */
	named: boolean;
}) {
	const [active, setActive] = useState<{ index: number; at: number } | null>(
		null,
	);
	const peak = Math.max(...rows.map((row) => row.total));
	const shown = active ? rows[active.index] : undefined;
	return (
		<figure aria-label="Input tokens by cache status" className="relative">
			<ul className="flex flex-col">
				{rows.map((row, index) => {
					const width = (row.total / peak) * 100;
					const rate = row.reuse === null ? "—" : percent.format(row.reuse);
					return (
						<li
							aria-label={`${row.full}: ${tokenCount(row.total)} input tokens, ${rate} reuse`}
							className={cn(
								"grid h-10 items-center gap-3 rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
								named ? "grid-cols-[8.25rem_minmax(0,1fr)]" : "grid-cols-1",
							)}
							key={row.full}
							onBlur={() => setActive(null)}
							onFocus={() => setActive({ index, at: width })}
							onPointerLeave={() => setActive(null)}
							onPointerMove={(event) => {
								const track = event.currentTarget.lastElementChild;
								const box = track?.getBoundingClientRect();
								if (box) {
									setActive({
										index,
										at: ((event.clientX - box.left) / box.width) * 100,
									});
								}
							}}
							// biome-ignore lint/a11y/noNoninteractiveTabindex: a row's parts are read in its tooltip, so the keyboard reaches it too
							tabIndex={0}
						>
							{named ? (
								<span
									className="truncate text-sm text-muted-foreground"
									title={row.full}
								>
									{row.name}
								</span>
							) : null}
							{/* The track keeps room after the longest bar for its total. */}
							<div className="relative h-7 pe-16">
								<div className="relative h-full">
									<div
										className={cn(
											"absolute inset-y-0 left-0 flex overflow-hidden rounded-[5px] transition-opacity",
											active && active.index !== index && "opacity-60",
										)}
										style={{ width: `${width}%` }}
									>
										{parts.map((part) =>
											row[part.key] > 0 ? (
												<span
													className="h-full"
													key={part.key}
													style={{
														width: `${(row[part.key] / row.total) * 100}%`,
														background: part.color,
													}}
												/>
											) : null,
										)}
									</div>
									<span
										className="absolute top-1/2 ms-2 -translate-y-1/2 text-sm font-medium tabular-nums"
										style={{ left: `${width}%` }}
										title={tokenCount(row.total)}
									>
										{compact.format(row.total)}
									</span>
								</div>
								{shown && active?.index === index ? (
									<ChartTooltip
										at={Math.min(Math.max(active.at, 0), 100)}
										className="top-[calc(100%+0.25rem)]"
										rows={parts.map((part) => ({
											key: part.key,
											label: part.label,
											color: part.color,
											value: tokenCount(shown[part.key]),
										}))}
										title={`${shown.full} · ${rate} reuse`}
										total={tokenCount(shown.total)}
									/>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
		</figure>
	);
}
