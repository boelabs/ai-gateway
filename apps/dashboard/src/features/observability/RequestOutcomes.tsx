"use client";

import type { getOverviewMetrics } from "./overview-data";
import { Panel } from "#/shared/components/Panel";

type Metrics = ReturnType<typeof getOverviewMetrics>;

const count = new Intl.NumberFormat("en-US");
const percent = new Intl.NumberFormat("en-US", {
	style: "percent",
	maximumFractionDigits: 1,
});

function share(rate: number | null): string {
	return rate === null ? "—" : percent.format(rate);
}

/**
 * How finished requests ended: the headline rate, the proportions as one bar, and the counts.
 *
 * Paired with `Reliability` in the column beside the activity chart. They are two cards rather than
 * one because they answer different questions — what the caller got back, and what the gateway had
 * to do to deliver it — and stacking them fills the column the chart sets the height of.
 */
const TICKS = 40;

/**
 * The outcomes as a row of ticks, each a fortieth of the finished requests, coloured by how they
 * ended. A share under one tick still gets one, so a single error is never invisible.
 */
function OutcomeTicks({
	outcomes,
	total,
}: {
	outcomes: { label: string; value: number; color: string }[];
	total: number;
}) {
	const present = outcomes.filter((row) => row.value > 0);
	const counts = present.map((row) =>
		Math.max(1, Math.round((row.value / Math.max(total, 1)) * TICKS)),
	);
	/** Rounding and the one-tick floor can overshoot; the largest share gives the difference back. */
	const overflow = counts.reduce((sum, n) => sum + n, 0) - TICKS;
	if (overflow !== 0 && counts.length > 0) {
		const largest = counts.indexOf(Math.max(...counts));
		counts[largest] = Math.max(1, (counts[largest] ?? 0) - overflow);
	}
	const ticks = present.flatMap((row, index) =>
		Array.from({ length: counts[index] ?? 0 }, () => row.color),
	);
	return (
		<div aria-hidden className="mt-5 flex h-8 gap-[3px]">
			{total > 0
				? ticks.map((color, index) => (
						<span
							className={`min-w-0 flex-1 rounded-[2px] ${color}`}
							// biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional.
							key={index}
						/>
					))
				: Array.from({ length: TICKS }, (_, index) => (
						<span
							className="min-w-0 flex-1 rounded-[2px] bg-muted"
							// biome-ignore lint/suspicious/noArrayIndexKey: ticks are positional.
							key={index}
						/>
					))}
		</div>
	);
}

export function RequestOutcomes({ metrics }: { metrics: Metrics }) {
	const outcomes = [
		{
			label: "Successful",
			value: metrics.outcomes.success,
			color: "bg-success",
		},
		{ label: "Errors", value: metrics.outcomes.error, color: "bg-danger" },
		{
			label: "Incomplete",
			value: metrics.outcomes.incomplete,
			color: "bg-warning",
		},
		{
			label: "Cancelled",
			value: metrics.outcomes.cancelled,
			color: "bg-chart-2",
		},
		{ label: "Blocked", value: metrics.outcomes.blocked, color: "bg-chart-3" },
		{
			label: "Abandoned",
			value: metrics.outcomes.abandoned,
			color: "bg-chart-4",
		},
		{ label: "Other", value: metrics.outcomes.unknown, color: "bg-chart-5" },
	].filter(
		(row) =>
			row.value > 0 || row.label === "Successful" || row.label === "Errors",
	);

	return (
		<Panel description="How finished requests ended." title={<h2>Outcomes</h2>}>
			<div className="flex items-baseline gap-2">
				<span className="text-[2rem] leading-none font-semibold tracking-tight tabular-nums">
					{share(metrics.successRate)}
				</span>
				<span className="text-sm text-muted-foreground">success rate</span>
			</div>
			<OutcomeTicks outcomes={outcomes} total={metrics.finishedRequests} />
			<dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3.5">
				{outcomes.map((row) => (
					<div
						className="flex min-w-0 items-center justify-between gap-2 text-xs"
						key={row.label}
					>
						<dt className="flex items-center gap-2 text-fg-muted">
							<span
								aria-hidden
								className={`size-1.5 shrink-0 rounded-full ${row.color}`}
							/>
							{row.label}
						</dt>
						<dd className="font-medium tabular-nums">
							{count.format(row.value)}
						</dd>
					</div>
				))}
			</dl>
			<div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-3 text-xs text-fg-muted tabular-nums">
				<span>{count.format(metrics.finishedRequests)} finished</span>
				<span>{count.format(metrics.outcomes.inProgress)} in progress</span>
			</div>
		</Panel>
	);
}

/**
 * What the gateway had to do behind those outcomes.
 *
 * A request that succeeded after three attempts and one that succeeded first time are the same row
 * in the card above; these are the counters that tell them apart, and the summary already carries
 * them.
 */
export function Reliability({ metrics }: { metrics: Metrics }) {
	const rows = [
		{
			label: "Requests with retries",
			value: count.format(metrics.retried),
			detail: share(metrics.retryRate),
		},
		{
			label: "Degraded",
			value: count.format(metrics.degraded),
			detail: share(metrics.degradedRate),
		},
		{ label: "Stalled streams", value: count.format(metrics.stalls) },
		{ label: "Protocol errors", value: count.format(metrics.protocolErrors) },
	];
	return (
		<Panel
			description="What it took to deliver them."
			title={<h2>Delivery</h2>}
		>
			<dl className="divide-y divide-border/50 text-sm">
				{rows.map((row) => (
					<div
						className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
						key={row.label}
					>
						<dt className="text-fg-muted">{row.label}</dt>
						<dd className="flex items-baseline gap-2 tabular-nums">
							<span className="font-medium">{row.value}</span>
							{row.detail ? (
								<span className="text-xs text-fg-muted">{row.detail}</span>
							) : null}
						</dd>
					</div>
				))}
			</dl>
		</Panel>
	);
}
