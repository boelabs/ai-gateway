"use client";

import { ActorUsage } from "./ActorUsage.tsx";
import type { UsageRow } from "./api.ts";
import { SearchableSelect, Select, SelectItem } from "#/components/ui/select";
import { type Column, DataTable } from "#/components/ui/datatable";
import { cacheReuseRate, tokenCount } from "./cache-usage";
import { Section } from "#/shared/components/Section";
import { phaseLabel, kindLabel } from "./trace.ts";
import { Panel } from "#/shared/components/Panel";
import { EmptyState } from "#/components/ui/page";
import { Button } from "#/components/ui/button";
import { MetricsChart } from "./MetricsChart";
import { RangeFilter } from "#/shared/components/RangeFilter.tsx";
import type { DetailedMetrics } from "./api";
import { CacheUsage } from "./CacheUsage";
import { StatCard } from "./StatCard";

import {
	CheckCircleIcon as IconCircleCheck,
	PulseIcon as IconActivity,
	MagnifyingGlassMinusIcon as IconSearchX,
	CubeIcon as IconBoxes,
	PathIcon as IconRoute,
	XIcon as IconX,
} from "@phosphor-icons/react/dist/ssr";

import {
	type MetricsSearch,
	reportedTokens,
	duration,
	compact,
	count,
	money,
	rate,
} from "./metrics-data";

type Deployment = DetailedMetrics["deployments"][number];
type Model = DetailedMetrics["models"][number];
type Failure = DetailedMetrics["failures"][number];

const operations = [
	["text.generate", "Text generation"],
	["image.generate", "Image generation"],
	["image.edit", "Image editing"],
	["embedding.create", "Embeddings"],
	["audio.transcribe", "Audio transcription"],
	["audio.transcribe.realtime", "Realtime transcription"],
	["audio.converse.realtime", "Realtime conversation"],
	["video.generate", "Video generation"],
	["rerank", "Reranking"],
	["decision.create", "Decisions"],
] as const;

function Breakdown({ data }: { data: DetailedMetrics }) {
	const { requests } = data;
	const outcomes = [
		{ label: "Success", value: requests.success, color: "bg-success" },
		{ label: "Error", value: requests.errors, color: "bg-danger" },
		{ label: "Incomplete", value: requests.incomplete, color: "bg-warning" },
		{ label: "Blocked", value: requests.blocked, color: "bg-chart-3" },
		{ label: "Cancelled", value: requests.cancelled, color: "bg-chart-4" },
		{
			label: "Abandoned / unknown",
			value: requests.abandoned + requests.unknown,
			color: "bg-chart-5",
		},
		{
			label: "In progress",
			value: requests.requests - requests.finished,
			color: "bg-chart-1",
		},
	];
	const tokens = data.attempts;
	return (
		<div className="grid gap-3 lg:grid-cols-2">
			<Panel
				description="Share of all requests by their latest outcome."
				title={<h2>Request outcomes</h2>}
			>
				<div className="flex flex-col gap-4">
					{outcomes.map((row) => (
						<div key={row.label}>
							<div className="mb-2 flex items-center justify-between gap-3 text-xs">
								<span>{row.label}</span>
								<span className="tabular-nums">
									{count.format(row.value)}{" "}
									<span className="ml-2 inline-block min-w-12 text-right text-fg-muted">
										{rate(row.value, requests.requests)}
									</span>
								</span>
							</div>
							<div aria-hidden className="h-4 border-l border-border/50">
								<div
									className={`h-full rounded-r ${row.color}`}
									style={{
										width: `${
											requests.requests
												? (row.value / requests.requests) * 100
												: 0
										}%`,
									}}
								/>
							</div>
						</div>
					))}
				</div>
			</Panel>
			<Panel
				description="Upstream usage, retries included. Reasoning and cache are part of these totals."
				title={<h2>Deployment token breakdown</h2>}
			>
				<div className="flex flex-col gap-4">
					{(
						[
							["Input", tokens.promptTokens, "bg-chart-input"],
							["Output", tokens.completionTokens, "bg-chart-output"],
						] as const
					).map(([label, value, color]) => (
						<div key={label}>
							<div className="mb-2 flex justify-between gap-3 text-sm">
								<span>{label}</span>
								<span className="tabular-nums">{tokenCount(value)}</span>
							</div>
							<div aria-hidden className="h-6 border-l border-border/50">
								<div
									className={`h-full rounded-r ${color}`}
									style={{
										width: `${
											tokens.totalTokens
												? ((value ?? 0) / tokens.totalTokens) * 100
												: 0
										}%`,
									}}
								/>
							</div>
						</div>
					))}
				</div>
				<dl className="mt-5 divide-y divide-border/50 text-sm">
					{(
						[
							["Reasoning", tokens.reasoningTokens],
							["Cache read", tokens.cacheReadTokens],
							["Cache write", tokens.cacheWriteTokens],
							["Search units", tokens.searchUnits],
						] as const
					).map(([label, value]) => (
						<div className="flex justify-between gap-3 py-2" key={label}>
							<dt className="text-fg-muted">{label}</dt>
							<dd className="tabular-nums">
								{value === null ? "—" : count.format(value)}
							</dd>
						</div>
					))}
				</dl>
				<p className="mt-3 text-xs text-fg-muted">
					Reported by {count.format(tokens.usageReported)} of{" "}
					{count.format(tokens.attempts)} attempts.
				</p>
			</Panel>
		</div>
	);
}

/** Table amounts: cents are what a row is compared by; the exact figure is the tooltip. */
const dollars = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

const METRICS_PERIODS = ["today", "yesterday", "7d", "30d", "custom"] as const;

const windowFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});

/** "Nov 12, 00:00 – 10:13 UTC": the exact window the numbers cover. */
function windowLabel(start: string, end: string): string {
	const [from, to] = [
		windowFormat.format(new Date(start)),
		windowFormat.format(new Date(end)),
	];
	const sameDay =
		from.slice(0, from.indexOf(",")) === to.slice(0, to.indexOf(","));
	return `${from} – ${sameDay ? to.slice(to.indexOf(",") + 2) : to} UTC`;
}

export function Metrics({
	data,
	options,
	search,
	refreshing,
	onChange,
	actors = [],
	keyNames = {},
}: {
	data: DetailedMetrics;
	/** Usage per API key or operator for the same window (unfiltered by model or deployment). */
	actors?: readonly UsageRow[];
	keyNames?: Readonly<Record<string, string>>;
	options: Pick<DetailedMetrics, "models" | "deployments">;
	search: MetricsSearch;
	/** Covers a filter navigation as well as a refresh: both replace what is on screen. */
	refreshing: boolean;
	onChange: (patch: Partial<MetricsSearch>) => void;
}) {
	const { requests } = data;
	const { attempts } = data;
	const modelOptions = options.models.flatMap((row) =>
		row.key ? [{ value: row.key, label: row.key }] : [],
	);
	if (
		search.publicModel &&
		!modelOptions.some((row) => row.value === search.publicModel)
	) {
		modelOptions.push({ value: search.publicModel, label: search.publicModel });
	}
	const deploymentOptions = options.deployments.flatMap((row) =>
		row.key
			? [
					{
						value: row.key,
						label: `${row.label ?? row.key.slice(0, 8)} · ${row.adapter ?? "unknown adapter"} · ${row.key.slice(0, 8)}`,
					},
				]
			: [],
	);
	if (
		search.deploymentId &&
		!deploymentOptions.some((row) => row.value === search.deploymentId)
	) {
		deploymentOptions.push({
			value: search.deploymentId,
			label: search.deploymentId,
		});
	}
	const deployments: Column<Deployment>[] = [
		{
			key: "label",
			header: "Deployment",
			render: (row) => (
				<Button
					className="px-0"
					disabled={!row.key}
					onClick={() => onChange({ deploymentId: row.key ?? undefined })}
					size="sm"
					title={[row.adapter, row.key].filter(Boolean).join(" · ")}
					variant="link"
				>
					{row.label ?? row.key?.slice(0, 8) ?? "Unattributed"}
				</Button>
			),
			compare: (a, b) => (a.label ?? "").localeCompare(b.label ?? ""),
		},
		{
			key: "attempts",
			header: "Attempts",
			align: "end",
			render: (row) => count.format(row.attempts),
			compare: (a, b) => a.attempts - b.attempts,
		},
		{
			key: "tokens",
			header: "Tokens",
			align: "end",
			render: (row) => (
				<span
					title={`${reportedTokens(row)} · ${row.usageReported} of ${row.attempts} attempts reported`}
				>
					{reportedTokens(row, true)}
				</span>
			),
			compare: (a, b) => a.totalTokens - b.totalTokens,
		},
		{
			key: "cache",
			header: "Cache reuse",
			align: "end",
			render: (row) => (
				<span
					title={`${tokenCount(row.cacheReadTokens)} cached input tokens · reads reported by ${tokenCount(row.cacheReadReported)} of ${row.attempts} attempts`}
				>
					{cacheReuseRate(row) === null
						? "—"
						: rate(
								row.cacheReadTokens ?? 0,
								(row.cacheReadTokens ?? 0) + (row.uncachedInputTokens ?? 0),
							)}
				</span>
			),
			compare: (a, b) => (cacheReuseRate(a) ?? -1) - (cacheReuseRate(b) ?? -1),
		},
		{
			key: "rate",
			header: "Error rate",
			align: "end",
			render: (row) => (
				<span
					className={
						row.finished && row.errors / row.finished >= 0.1
							? "text-destructive-foreground"
							: undefined
					}
					title={`${count.format(row.errors)} errors of ${count.format(row.finished)} finished attempts`}
				>
					{rate(row.errors, row.finished)}
				</span>
			),
			compare: (a, b) =>
				a.errors / (a.finished || 1) - b.errors / (b.finished || 1),
		},
		{
			key: "latency",
			header: "Latency p95",
			align: "end",
			render: (row) => duration(row.p95DurationMs),
			compare: (a, b) => (a.p95DurationMs ?? -1) - (b.p95DurationMs ?? -1),
		},
	];
	const models: Column<Model>[] = [
		{
			key: "model",
			header: "Public model",
			render: (row) => (
				<Button
					className="px-0"
					disabled={!row.key}
					onClick={() =>
						onChange({
							publicModel: row.key ?? undefined,
							deploymentId: undefined,
						})
					}
					size="sm"
					variant="link"
				>
					{row.key ?? "Unattributed"}
				</Button>
			),
			compare: (a, b) => (a.key ?? "").localeCompare(b.key ?? ""),
		},
		{
			key: "requests",
			header: "Requests",
			align: "end",
			render: (row) => count.format(row.requests),
			compare: (a, b) => a.requests - b.requests,
		},
		{
			key: "tokens",
			header: "Tokens",
			align: "end",
			render: (row) => (
				<span title={reportedTokens(row)}>{reportedTokens(row, true)}</span>
			),
			compare: (a, b) => a.totalTokens - b.totalTokens,
		},
		{
			key: "errors",
			header: "Errors",
			align: "end",
			render: (row) => count.format(row.errors),
			compare: (a, b) => a.errors - b.errors,
		},
		{
			key: "cost",
			header: "Cost",
			align: "end",
			render: (row) => (
				<span title={money(row.consumerCostCents)}>
					{dollars.format(row.consumerCostCents / 100)}
				</span>
			),
			compare: (a, b) => a.consumerCostCents - b.consumerCostCents,
		},
		{
			key: "latency",
			header: "Latency p95",
			align: "end",
			render: (row) => duration(row.p95DurationMs),
			compare: (a, b) => (a.p95DurationMs ?? -1) - (b.p95DurationMs ?? -1),
		},
	];
	const failures: Column<Failure>[] = [
		{
			key: "deployment",
			header: "Deployment",
			render: (row) => (
				<span title={row.deploymentId ?? undefined}>
					{row.label ?? row.deploymentId?.slice(0, 8) ?? "Unattributed"}
				</span>
			),
		},
		{
			key: "kind",
			header: "Failure",
			render: (row) => {
				const kind = kindLabel(row.kind) ?? "Unclassified";
				const label = kind.charAt(0).toUpperCase() + kind.slice(1);
				return row.status ? `${label} · ${row.status}` : label;
			},
		},
		{
			key: "phase",
			header: "Phase",
			render: (row) => phaseLabel(row.phase) ?? "—",
		},

		{
			key: "count",
			header: "Errors",
			align: "end",
			render: (row) => count.format(row.count),
			compare: (a, b) => a.count - b.count,
		},
	];
	return (
		<div aria-busy={refreshing} className="flex flex-col gap-6">
			{/* One row of filters, no frame: the controls are the toolbar. */}
			<div className="flex flex-wrap items-center gap-2">
				<RangeFilter
					fallback="today"
					onChange={(patch) => onChange(patch as Partial<MetricsSearch>)}
					periods={METRICS_PERIODS}
					value={search}
				/>
				<Select
					aria-label="Operation"
					onValueChange={(value) =>
						onChange({
							operation:
								value === "all"
									? undefined
									: (value as MetricsSearch["operation"]),
							publicModel: undefined,
							deploymentId: undefined,
						})
					}
					value={search.operation ?? "all"}
					width="13rem"
				>
					<SelectItem value="all">All operations</SelectItem>
					{operations.map(([value, label]) => (
						<SelectItem key={value} value={value}>
							{label}
						</SelectItem>
					))}
				</Select>
				<SearchableSelect
					aria-label="Public model"
					clearLabel="All public models"
					items={modelOptions}
					onValueChange={(value) =>
						onChange({
							publicModel: value ?? undefined,
							deploymentId: undefined,
						})
					}
					searchPlaceholder="Search public models"
					value={search.publicModel ?? null}
					width="13rem"
				/>
				<SearchableSelect
					aria-label="Deployment"
					clearLabel="All deployments"
					items={deploymentOptions}
					onValueChange={(value) =>
						onChange({ deploymentId: value ?? undefined })
					}
					searchPlaceholder="Search deployments"
					value={search.deploymentId ?? null}
					width="15rem"
				/>
				{search.publicModel || search.deploymentId || search.operation ? (
					<Button
						onClick={() =>
							onChange({
								publicModel: undefined,
								deploymentId: undefined,
								operation: undefined,
							})
						}
						variant="ghost"
					>
						<IconX aria-hidden />
						Clear filters
					</Button>
				) : null}
				<p
					className="ms-auto text-xs text-muted-foreground tabular-nums"
					role="status"
					title="Retained records, grouped by request start"
				>
					{windowLabel(data.start, data.end)}
				</p>
			</div>
			{search.deploymentId ? (
				<p className="rounded-lg border border-border bg-secondary/40 p-3 text-sm text-fg-muted">
					Request metrics cover requests that used this deployment, including
					any fallback. Deployment tokens and errors cover only its own
					attempts.
				</p>
			) : null}
			<section
				aria-label="Metrics summary"
				className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
			>
				<StatCard
					detail="Includes retries"
					exact={reportedTokens(attempts)}
					label="Deployment tokens"
					value={reportedTokens(attempts, true)}
				/>
				<StatCard
					detail={`${rate(requests.success, requests.finished)} successful`}
					exact={count.format(requests.requests)}
					label="Requests"
					value={compact.format(requests.requests)}
				/>
				<StatCard
					detail={`${dollars.format(requests.upstreamCostCents / 100)} upstream`}
					exact={money(requests.consumerCostCents)}
					label="Consumer cost"
					value={dollars.format(requests.consumerCostCents / 100)}
				/>
				<StatCard
					detail={`${rate(attempts.errors, attempts.finished)} of attempts`}
					label="Deployment errors"
					value={count.format(attempts.errors)}
				/>
				<StatCard
					detail={`${duration(requests.p50DurationMs)} median`}
					label="Request latency · p95"
					value={duration(requests.p95DurationMs)}
				/>
				<StatCard
					detail={`${count.format(requests.cacheHits)} cache hits`}
					exact={reportedTokens(requests)}
					label="Request tokens"
					value={reportedTokens(requests, true)}
				/>
			</section>
			{requests.requests === 0 ? (
				<EmptyState
					description="Change the dates or clear filters. Metrics appear after the gateway records traffic."
					icon={IconActivity}
					title="No activity in this period"
				/>
			) : (
				<>
					<div className="grid gap-3 xl:grid-cols-2">
						<MetricsChart data={data} />
						<MetricsChart data={data} upstream />
					</div>
					<CacheUsage records={attempts.attempts} upstream usage={attempts} />
					<Breakdown data={data} />
					<Section
						description="Select one to inspect it. Error rates use finished attempts."
						title="By deployment"
					>
						<DataTable
							caption="Deployment metrics"
							columns={deployments}
							emptyMessage={
								data.deployments.length === 0 ? (
									<EmptyState
										description="Requests may have been cached or rejected before routing."
										framed={false}
										icon={IconRoute}
										title="No upstream attempts"
									/>
								) : (
									<EmptyState
										description="Try another name, adapter or ID."
										framed={false}
										icon={IconSearchX}
										title="No deployments match"
									/>
								)
							}
							pagination={{ pageSize: 10 }}
							rowKey={(row) => row.key ?? "none"}
							rows={[...data.deployments].sort(
								(a, b) => b.totalTokens - a.totalTokens,
							)}
							search={{
								getText: (row) => `${row.label} ${row.adapter} ${row.key}`,
								placeholder: "Search deployments…",
							}}
						/>
					</Section>
					<Section
						description="Each request counts once, however many attempts it took."
						title="By public model"
					>
						<DataTable
							caption="Public model metrics"
							columns={models}
							emptyMessage={
								data.models.length === 0 ? (
									<EmptyState
										description="Requests in this period named no public model."
										framed={false}
										icon={IconBoxes}
										title="No public models"
									/>
								) : (
									<EmptyState
										description="Try another public model name."
										framed={false}
										icon={IconSearchX}
										title="No public models match"
									/>
								)
							}
							pagination={{ pageSize: 10 }}
							rowKey={(row) => row.key ?? "none"}
							rows={data.models}
							search={{
								getText: (row) => row.key ?? "",
								placeholder: "Search public models…",
							}}
						/>
					</Section>
					<ActorUsage keyNames={keyNames} rows={actors} />
					<Section
						description="Failed attempts, including failures recovered by retries or fallback."
						title="Deployment failures"
					>
						<DataTable
							caption="Deployment failure breakdown"
							columns={failures}
							emptyMessage={
								<EmptyState
									description="Every deployment attempt in this period finished without an error."
									framed={false}
									icon={IconCircleCheck}
									title="No deployment errors"
								/>
							}
							pagination={{ pageSize: 10 }}
							rowKey={(row) =>
								JSON.stringify([
									row.deploymentId,
									row.kind,
									row.phase,
									row.status,
								])
							}
							rows={[...data.failures].sort((a, b) => b.count - a.count)}
						/>
					</Section>
				</>
			)}
		</div>
	);
}
