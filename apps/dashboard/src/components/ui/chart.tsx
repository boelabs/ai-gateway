"use client";

import { area as d3area, line as d3line, curveMonotoneX } from "d3-shape";
import { cn } from "#/shared/lib/classes";
import { scaleLinear } from "d3-scale";

import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

/*
 * Charts in the Rosen way (rosencharts.com): D3 only does the math (scales, paths) and everything
 * drawn is plain SVG and HTML. The plot is an SVG in a 0–100 viewBox stretched to its box, with
 * non-scaling strokes, so it needs no measuring to render; axes, bars and the tooltip are HTML placed
 * in percentages, so text stays crisp and radii stay round at any size.
 */

export interface ChartSeries {
	key: string;
	label: string;
	color: string;
}

export interface ChartPoint {
	timestamp: number;
	[key: string]: number | null;
}

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const count = new Intl.NumberFormat("en-US");

/** The widest a bar gets, and the room every x label needs before the axis thins them out. */
const MAX_BAR = 28;
const X_LABEL_ROOM = 88;

/** Compare same-unit series from zero so each curve matches its tooltip value. */
export function TimeSeriesChart({
	rows,
	series,
	kind = "area",
	bucket,
	label,
	formatValue = (value) => count.format(value),
	formatTick = (value) => compact.format(value),
	intervalLabel,
	stacked = false,
}: {
	rows: ChartPoint[];
	series: readonly ChartSeries[];
	kind?: "area" | "bar" | "line";
	/**
	 * Bars only: stack the series into one column per interval. Only for series that are disjoint
	 * parts of one total (input and output tokens), never for overlapping subsets.
	 */
	stacked?: boolean;
	bucket: "hour" | "day";
	label: string;
	formatValue?: (value: number) => string;
	formatTick?: (value: number) => string;
	intervalLabel?: (timestamp: number) => string;
}) {
	const id = useId().replaceAll(":", "");
	const plot = useRef<HTMLDivElement>(null);
	const width = useWidth(plot);
	const [active, setActive] = useState<number | null>(null);

	const date = new Intl.DateTimeFormat("en-US", {
		timeZone: "UTC",
		...(bucket === "hour"
			? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
			: { month: "short", day: "numeric" }),
	});
	const describe =
		intervalLabel ??
		((timestamp: number) =>
			`${new Date(timestamp).toLocaleString("en-US", { timeZone: "UTC" })} UTC`);

	const measured = rows.some((row) =>
		series.some((item) => row[item.key] != null),
	);
	const positive = rows.some((row) =>
		series.some((item) => (row[item.key] ?? 0) > 0),
	);
	const isBar = kind === "bar";
	const stack = isBar && stacked;
	const peak = Math.max(
		0,
		...rows.map((row) =>
			stack
				? series.reduce((sum, item) => sum + (row[item.key] ?? 0), 0)
				: Math.max(0, ...series.map((item) => row[item.key] ?? 0)),
		),
	);
	const y = scaleLinear()
		.domain([0, peak > 0 ? peak : 1])
		.nice(4)
		.range([100, 0]);
	const ticks = y.ticks(4);
	const n = rows.length;
	/** Where an interval sits across the plot, in percent: band centres for bars, edges for curves. */
	const x = (index: number) => {
		if (isBar) {
			return ((index + 0.5) / n) * 100;
		}
		return n > 1 ? (index / (n - 1)) * 100 : 50;
	};
	const xTicks = evenly(n, Math.max(2, Math.floor(width / X_LABEL_ROOM)));

	function pick(event: PointerEvent<HTMLElement>) {
		const box = event.currentTarget.getBoundingClientRect();
		const ratio = Math.min(
			Math.max((event.clientX - box.left) / box.width, 0),
			1,
		);
		setActive(
			isBar
				? Math.min(n - 1, Math.floor(ratio * n))
				: Math.round(ratio * (n - 1)),
		);
	}

	function walk(event: KeyboardEvent<HTMLElement>) {
		const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
		if (step) {
			event.preventDefault();
			setActive((current) =>
				Math.min(n - 1, Math.max(0, (current ?? n - 1) + step)),
			);
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActive(event.key === "Home" ? 0 : n - 1);
		} else if (event.key === "Escape") {
			setActive(null);
		}
	}

	const activeRow = active === null ? undefined : rows[active];

	return (
		<figure aria-label={label} className="flex min-w-0 flex-1 flex-col">
			<div className="relative h-64 min-h-64 w-full flex-1 text-xs">
				{/* Y axis: the gridlines span the plot, their values sit in the gutter on the left. */}
				<div className="absolute top-3 right-2 bottom-8 left-14">
					{ticks.map((tick) => (
						<div
							aria-hidden
							className={cn(
								"absolute inset-x-0 border-t",
								tick === 0 ? "border-border" : "border-dashed border-border/50",
							)}
							key={tick}
							style={{ top: `${y(tick)}%` }}
						>
							<span className="absolute right-[calc(100%+0.75rem)] -translate-y-1/2 whitespace-nowrap text-fg-muted tabular-nums">
								{formatTick(tick)}
							</span>
						</div>
					))}

					<div className="absolute inset-0" ref={plot}>
						{isBar ? (
							<Bars
								active={active}
								rows={rows}
								series={series}
								stacked={stack}
								y={y}
							/>
						) : (
							<Curves
								id={id}
								kind={kind}
								rows={rows}
								series={series}
								x={x}
								y={y}
							/>
						)}

						{/* The hovered interval: a guide for curves, a soft band for bars. */}
						{activeRow && !isBar ? (
							<div
								aria-hidden
								className="pointer-events-none absolute inset-y-0 border-l border-fg-muted/40"
								style={{ left: `${x(active ?? 0)}%` }}
							>
								{series.map((item) => {
									const value = activeRow[item.key];
									return value == null ? null : (
										<span
											className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
											key={item.key}
											style={{
												left: -0.5,
												top: `${y(value)}%`,
												background: item.color,
											}}
										/>
									);
								})}
							</div>
						) : null}

						{/* X axis: as many labels as fit, spread evenly, the ends kept inside the plot. */}
						{xTicks.map((index) => {
							const row = rows[index];
							if (!row) {
								return null;
							}
							const at = x(index);
							return (
								<span
									aria-hidden
									className={cn(
										"absolute top-[calc(100%+0.75rem)] whitespace-nowrap text-fg-muted tabular-nums",
										// Centred under its interval, except where that would leave the plot.
										edgeAlign(at),
									)}
									key={row.timestamp}
									style={{ left: `${at}%` }}
								>
									{date.format(row.timestamp)}
								</span>
							);
						})}

						{/* The pointer and the arrow keys walk the intervals; the tooltip follows. */}
						{n > 0 ? (
							<div
								aria-label={`${label}. Use the arrow keys to read each interval.`}
								className="absolute inset-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
								onBlur={() => setActive(null)}
								onFocus={() => setActive((current) => current ?? n - 1)}
								onKeyDown={walk}
								onPointerLeave={() => setActive(null)}
								onPointerMove={pick}
								role="application"
								// biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys walk the intervals, so the plot takes the focus
								tabIndex={0}
							/>
						) : null}

						{activeRow ? (
							<ChartTooltip
								at={x(active ?? 0)}
								rows={series.map((item) => ({
									key: item.key,
									label: item.label,
									color: item.color,
									value:
										activeRow[item.key] == null
											? "Not reported"
											: formatValue(Number(activeRow[item.key])),
								}))}
								title={describe(activeRow.timestamp)}
								total={
									stack && series.length > 1
										? formatValue(
												series.reduce(
													(sum, item) => sum + (activeRow[item.key] ?? 0),
													0,
												),
											)
										: undefined
								}
							/>
						) : null}
					</div>
				</div>
				{!positive && (
					<p className="pointer-events-none absolute inset-0 flex items-center justify-center text-fg-muted">
						{measured
							? "All recorded values are zero"
							: "No measurements reported"}
					</p>
				)}
			</div>
			<figcaption className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs">
				{series.map((item) => (
					<span className="flex items-center gap-2" key={item.key}>
						<span
							aria-hidden
							className="size-2.5 rounded-sm"
							style={{ background: item.color }}
						/>
						{item.label}
					</span>
				))}
			</figcaption>
			{/* The exact values, for screen readers: sighted operators read them in the tooltip. */}
			<div className="sr-only">
				<table>
					<caption>{label}</caption>
					<thead>
						<tr>
							<th scope="col">Interval · UTC</th>
							{series.map((item) => (
								<th key={item.key} scope="col">
									{item.label}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.timestamp}>
								<th scope="row">{describe(row.timestamp)}</th>
								{series.map((item) => (
									<td key={item.key}>
										{row[item.key] == null
											? "Not reported"
											: formatValue(Number(row[item.key]))}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</figure>
	);
}

type Scale = (value: number) => number;

/** Areas and lines: one stretched SVG, strokes kept at their width by `non-scaling-stroke`. */
function Curves({
	id,
	kind,
	rows,
	series,
	x,
	y,
}: {
	id: string;
	kind: "area" | "line";
	rows: ChartPoint[];
	series: readonly ChartSeries[];
	x: Scale;
	y: Scale;
}) {
	const indexed = rows.map((row, index) => ({ row, index }));
	type Datum = (typeof indexed)[number];
	return (
		<svg
			aria-hidden
			className="absolute inset-0 size-full overflow-visible"
			preserveAspectRatio="none"
			viewBox="0 0 100 100"
		>
			<defs>
				{series.map((item) => (
					<linearGradient
						id={`${id}-${item.key}`}
						key={item.key}
						x1="0"
						x2="0"
						y1="0"
						y2="1"
					>
						<stop offset="0%" stopColor={item.color} stopOpacity={0.32} />
						<stop offset="100%" stopColor={item.color} stopOpacity={0} />
					</linearGradient>
				))}
			</defs>
			{series.map((item) => {
				const defined = (d: Datum) => d.row[item.key] != null;
				const line = d3line<Datum>()
					.defined(defined)
					.x((d) => x(d.index))
					.y((d) => y(d.row[item.key] ?? 0))
					.curve(curveMonotoneX)(indexed);
				const fill =
					kind === "area"
						? d3area<Datum>()
								.defined(defined)
								.x((d) => x(d.index))
								.y0(y(0))
								.y1((d) => y(d.row[item.key] ?? 0))
								.curve(curveMonotoneX)(indexed)
						: null;
				// A lone point (or the points of a short line) as a dot: a zero-length round-capped path
				// stays a circle however the viewBox stretches.
				const dots =
					rows.length === 1 || (kind === "line" && rows.length <= 31)
						? indexed.filter(defined)
						: [];
				return (
					<g key={item.key}>
						{fill ? <path d={fill} fill={`url(#${id}-${item.key})`} /> : null}
						{line ? (
							<path
								d={line}
								fill="none"
								stroke={item.color}
								strokeLinejoin="round"
								strokeWidth={2}
								vectorEffect="non-scaling-stroke"
							/>
						) : null}
						{dots.map((d) => (
							<path
								d={`M ${x(d.index)} ${y(d.row[item.key] ?? 0)} l 0.0001 0`}
								key={d.index}
								stroke={item.color}
								strokeLinecap="round"
								strokeWidth={rows.length === 1 ? 7 : 4}
								vectorEffect="non-scaling-stroke"
							/>
						))}
					</g>
				);
			})}
		</svg>
	);
}

/** Bars: one band per interval, HTML columns so the rounded tops stay round at any size. */
function Bars({
	rows,
	series,
	stacked,
	y,
	active,
}: {
	rows: ChartPoint[];
	series: readonly ChartSeries[];
	stacked: boolean;
	y: Scale;
	active: number | null;
}) {
	const height = (value: number) => 100 - y(value);
	return (
		<div aria-hidden className="absolute inset-0 flex">
			{rows.map((row, index) => {
				const values = series.map((item) => ({
					item,
					value: row[item.key] ?? 0,
				}));
				// A stack rounds only its top: the highest part that has anything in it.
				const top = lastIndex(values, (entry) => entry.value > 0);
				return (
					<div
						className={cn(
							"relative flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 rounded-sm transition-colors",
							active === index && "bg-foreground/5",
						)}
						key={row.timestamp}
					>
						{stacked ? (
							<div
								className="flex h-full w-[70%] flex-col-reverse"
								style={{ maxWidth: MAX_BAR }}
							>
								{values.map(({ item, value }, part) =>
									value > 0 ? (
										<div
											className={cn(
												"w-full",
												part === top && "rounded-t-[4px]",
											)}
											key={item.key}
											style={{
												height: `${height(value)}%`,
												background: item.color,
											}}
										/>
									) : null,
								)}
							</div>
						) : (
							values.map(({ item, value }) => (
								<div
									className="w-full rounded-t-[4px]"
									key={item.key}
									style={{
										height: value > 0 ? `${height(value)}%` : 0,
										maxWidth: MAX_BAR / (series.length > 1 ? 2 : 1),
										background: item.color,
									}}
								/>
							))
						)}
					</div>
				);
			})}
		</div>
	);
}

export interface ChartTooltipRow {
	key: string;
	label: string;
	color: string;
	value: ReactNode;
}

/**
 * The values of what the pointer is over, beside it: on its right, or on its left past the middle
 * so it never leaves the chart. `at` is the anchor across the plot, in percent.
 */
export function ChartTooltip({
	at,
	title,
	rows,
	total,
	className,
}: {
	at: number;
	title: ReactNode;
	rows: readonly ChartTooltipRow[];
	total?: ReactNode;
	className?: string;
}) {
	const flip = at > 55;
	return (
		<div
			className={cn(
				"pointer-events-none absolute top-0 z-10 flex min-w-44 flex-col gap-1.5 rounded-lg border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-lg/5",
				flip ? "-translate-x-[calc(100%+0.75rem)]" : "translate-x-3",
				className,
			)}
			role="status"
			style={{ left: `${at}%` }}
		>
			<p className="font-medium whitespace-nowrap">{title}</p>
			<ul className="flex flex-col gap-1">
				{rows.map((row) => (
					<li className="flex items-center gap-2" key={row.key}>
						<span
							aria-hidden
							className="size-2.5 shrink-0 rounded-sm"
							style={{ background: row.color }}
						/>
						<span className="text-muted-foreground">{row.label}</span>
						<span className="ms-auto ps-4 font-medium tabular-nums">
							{row.value}
						</span>
					</li>
				))}
			</ul>
			{total === undefined ? null : (
				<p className="flex items-center justify-between gap-4 border-t pt-1.5">
					<span className="text-muted-foreground">Total</span>
					<span className="font-medium tabular-nums">{total}</span>
				</p>
			)}
		</div>
	);
}

function edgeAlign(at: number): string {
	if (at < 6) {
		return "translate-x-0";
	}
	return at > 94 ? "-translate-x-full" : "-translate-x-1/2";
}

function lastIndex<T>(items: readonly T[], test: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item !== undefined && test(item)) {
			return index;
		}
	}
	return -1;
}

/** Up to `most` indices out of `n`, evenly spread, always the first and the last. */
function evenly(n: number, most: number): number[] {
	if (n <= most) {
		return Array.from({ length: n }, (_, index) => index);
	}
	const step = (n - 1) / (most - 1);
	return Array.from({ length: most }, (_, index) => Math.round(index * step));
}

/** An element's width, kept current; until it is measured, a typical panel's. */
function useWidth(ref: { current: HTMLElement | null }): number {
	const [width, setWidth] = useState(560);
	useEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const observer = new ResizeObserver(([entry]) => {
			if (entry) {
				setWidth(entry.contentRect.width);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
