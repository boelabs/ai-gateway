"use client";

import { buildUsageSeries, getOverviewMetrics } from "./overview-data";
import { type StatusProps, Status } from "#/components/ui/status";
import { RequestOutcomes, Reliability } from "./RequestOutcomes";
import { aggregateCacheUsage } from "./cache-usage";
import { actorName } from "./actors.ts";
import type { Readiness } from "#/shared/api/health.ts";
import type { UsageBucket } from "./overview-data";
import { ActivityChart } from "./ActivityChart";
import type { Summary, UsageRow } from "./api";
import { CacheUsage } from "./CacheUsage";
import { StatCard } from "./StatCard";

import {
	CurrencyDollarIcon as IconCurrencyDollar,
	PulseIcon as IconActivity,
	StackIcon as IconStack2,
	HardDrivesIcon as IconServer,
	ClockIcon as IconClock,
} from "@phosphor-icons/react/dist/ssr";

const count = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const percent = new Intl.NumberFormat("en-US", {
	style: "percent",
	maximumFractionDigits: 1,
});

function cost(cents: number): string {
	return `$${(cents / 100).toFixed(cents > 0 && cents < 100 ? 4 : 2)}`;
}

function duration(ms: number | null): string {
	if (ms === null) {
		return "—";
	}
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/**
 * Green when the rate is healthy, amber when it needs a look, red only when most requests fail:
 * a red tile at 87% cries wolf, and an operator learns to stop reading the colour.
 */
function successTone(rate: number | null): StatusProps["tone"] {
	if (rate === null) {
		return "neutral";
	}
	if (rate >= 0.95) {
		return "success";
	}
	return rate >= 0.5 ? "warning" : "danger";
}

/**
 * Postgres, Redis, the extension runtime and operation persistence, as the gateway itself reports
 * them. Usage numbers are drawn from the same database this row says is reachable — so when it is
 * not, the tables below are stale rather than empty, and an operator has to be told which.
 */
export function SystemStatus({ ready }: { ready: Readiness | null }) {
	if (!ready) {
		return (
			<Status tone="warning">
				<IconServer aria-hidden className="size-3.5" />
				health unreachable
			</Status>
		);
	}
	const healthy = ready.status === "ok";
	const failing = [
		ready.dependencies.database ? null : "database",
		ready.dependencies.cache ? null : "cache",
		ready.observability && !ready.observability.healthy ? "logging" : null,
		ready.extensions && !ready.extensions.healthy ? "extensions" : null,
	].filter(Boolean);
	return (
		<Status tone={healthy ? "success" : "danger"}>
			<IconServer aria-hidden className="size-3.5" />
			{healthy ? "all systems ready" : `degraded: ${failing.join(", ")}`}
		</Status>
	);
}

export interface OverviewProps {
	health: Summary;
	byModel: UsageRow[];
	byActor: UsageRow[];
	/** API key names for the per-key breakdown; ids show where a name is missing. */
	keyNames?: Readonly<Record<string, string>>;
	/** Grouped by hour or by day, matching `bucket` — the range decides which. */
	byInterval: UsageRow[];
	start: string;
	end: string;
	bucket: UsageBucket;
}

/**
 * The body of the overview, and nothing else.
 *
 * The page header, the system-status badge, the refresh controls and the "Summary" heading with the
 * range control are rendered by the page around this component rather than inside it: they need
 * either no data or a different request, so keeping them out is what lets the page paint its chrome
 * before any of these numbers exist.
 */
export function Overview({
	health,
	byModel,
	byActor,
	byInterval,
	keyNames = {},
	start,
	end,
	bucket,
}: OverviewProps) {
	const metrics = getOverviewMetrics(health, byModel);
	const series = buildUsageSeries(byInterval, start, end, bucket);
	const modelCount = byModel.filter(
		(row) => row.key !== null && row.requests > 0,
	).length;

	return (
		<div className="flex flex-col gap-6">
			<section
				aria-label="Usage summary"
				className="grid grid-cols-2 gap-3 lg:grid-cols-4"
			>
				<StatCard
					detail={`Across ${modelCount} public ${modelCount === 1 ? "model" : "models"}`}
					exact={count.format(metrics.requests)}
					icon={IconActivity}
					label="Requests"
					note={{
						text:
							metrics.successRate === null
								? "no outcomes"
								: `${percent.format(metrics.successRate)} success`,
						tone: successTone(metrics.successRate),
					}}
					value={compact.format(metrics.requests)}
				/>
				<StatCard
					detail={`${compact.format(metrics.promptTokens)} input`}
					exact={count.format(metrics.totalTokens)}
					icon={IconStack2}
					label="Total tokens"
					note={{
						text: `${compact.format(metrics.completionTokens)} output`,
						exact: `${count.format(metrics.completionTokens)} output tokens`,
					}}
					value={compact.format(metrics.totalTokens)}
				/>
				<StatCard
					detail={`${cost(metrics.upstreamCostCents)} upstream cost`}
					icon={IconCurrencyDollar}
					label="Consumer cost"
					note={{
						text:
							metrics.requests > 0
								? `${cost(metrics.consumerCostCents / metrics.requests)}/req`
								: "no requests",
					}}
					value={cost(metrics.consumerCostCents)}
				/>
				<StatCard
					detail="Time to first output"
					icon={IconClock}
					label="First output · p95"
					note={{ text: `${count.format(metrics.retried)} retried` }}
					value={duration(metrics.p95FirstOutputMs)}
				/>
			</section>

			<div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<ActivityChart bucket={bucket} rows={series} updatedAt={end} />
				<div className="grid min-w-0 content-start gap-3">
					<RequestOutcomes metrics={metrics} />
					<Reliability metrics={metrics} />
				</div>
			</div>
			<CacheUsage
				breakdowns={[
					{ id: "model", label: "By model", rows: byModel },
					{
						id: "actor",
						label: "By key",
						rows: byActor,
						name: (key) => actorName(key, keyNames),
					},
				]}
				records={metrics.requests}
				usage={aggregateCacheUsage(byModel)}
			/>
		</div>
	);
}
