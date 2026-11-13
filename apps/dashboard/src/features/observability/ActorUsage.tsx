"use client";

import {
	DownloadSimpleIcon as IconDownload,
	UsersIcon as IconUsers,
} from "@phosphor-icons/react/dist/ssr";
import { type Column, DataTable } from "#/components/ui/datatable";
import { Section } from "#/shared/components/Section";
import { actorName, isKeyActor } from "./actors.ts";
import { EmptyState } from "#/components/ui/page";
import { downloadCsv } from "#/shared/lib/csv.ts";
import { Button } from "#/components/ui/button";
import { cacheReuseRate } from "./cache-usage";
import type { UsageRow } from "./api";

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

/** Spend per key is the number that ends up in someone else's spreadsheet. */
function ExportButton({ rows }: { rows: readonly UsageRow[] }) {
	return (
		<Button
			disabled={rows.length === 0}
			onClick={() =>
				downloadCsv(
					`usage-by-key-${new Date().toISOString().slice(0, 10)}.csv`,
					[...rows],
					[
						["actor", (row) => row.key],
						["requests", (row) => row.requests],
						["promptTokens", (row) => row.promptTokens],
						["completionTokens", (row) => row.completionTokens],
						["totalTokens", (row) => row.totalTokens],
						["cacheReadTokens", (row) => row.cacheReadTokens ?? null],
						["uncachedInputTokens", (row) => row.uncachedInputTokens ?? null],
						["consumerCostCents", (row) => row.consumerCostCents],
						["upstreamCostCents", (row) => row.upstreamCostCents],
					],
				)
			}
			variant="secondary"
		>
			<IconDownload aria-hidden />
			Export
		</Button>
	);
}

/**
 * Who is spending: one row per API key or operator, named rather than numbered, one value per
 * cell. Ids, the in/out split and each row's share of the cost are in the cells' tooltips.
 */
export function ActorUsage({
	rows,
	keyNames,
}: {
	rows: readonly UsageRow[];
	keyNames: Readonly<Record<string, string>>;
}) {
	const sorted = [...rows].sort(
		(a, b) => b.consumerCostCents - a.consumerCostCents,
	);
	const totalCost = sorted.reduce((sum, row) => sum + row.consumerCostCents, 0);
	const columns: Column<UsageRow>[] = [
		{
			key: "actor",
			header: "Name",
			render: (row) => (
				<span
					className="block truncate font-medium"
					title={`${isKeyActor(row.key) ? "API key" : "Operator"} · ${row.key ?? "—"}`}
				>
					{actorName(row.key, keyNames)}
				</span>
			),
			compare: (a, b) =>
				actorName(a.key, keyNames).localeCompare(actorName(b.key, keyNames)),
		},
		{
			key: "requests",
			header: "Requests",
			align: "end",
			render: (row) => (
				<span className="tabular-nums">{count.format(row.requests)}</span>
			),
			compare: (a, b) => a.requests - b.requests,
		},
		{
			key: "tokens",
			header: "Tokens",
			align: "end",
			render: (row) => (
				<span
					className="tabular-nums"
					title={`${count.format(row.totalTokens)} · ${count.format(row.promptTokens)} in · ${count.format(row.completionTokens)} out`}
				>
					{compact.format(row.totalTokens)}
				</span>
			),
			compare: (a, b) => a.totalTokens - b.totalTokens,
		},
		{
			key: "reuse",
			header: "Cache reuse",
			align: "end",
			render: (row) => {
				const reuse = cacheReuseRate(row);
				return (
					<span className="tabular-nums">
						{reuse === null ? "—" : percent.format(reuse)}
					</span>
				);
			},
			compare: (a, b) => (cacheReuseRate(a) ?? -1) - (cacheReuseRate(b) ?? -1),
		},
		{
			key: "cost",
			header: "Cost",
			align: "end",
			render: (row) => (
				<span
					className="font-medium tabular-nums"
					title={
						totalCost > 0
							? `${percent.format(row.consumerCostCents / totalCost)} of the period's cost`
							: undefined
					}
				>
					{cost(row.consumerCostCents)}
				</span>
			),
			compare: (a, b) => a.consumerCostCents - b.consumerCostCents,
		},
	];
	return (
		<Section
			action={<ExportButton rows={sorted} />}
			description="Spend per API key or operator, playground included."
			title="By API key"
		>
			<DataTable
				caption="Usage by API key or operator"
				columns={columns}
				emptyMessage={
					<EmptyState
						description="Requests, tokens and cost per key appear here as traffic arrives."
						framed={false}
						icon={IconUsers}
						title="No usage in this period"
					/>
				}
				pagination={{ pageSize: 10 }}
				rowKey={(row) => row.key ?? "none"}
				rows={sorted}
				search={{
					getText: (row) => `${actorName(row.key, keyNames)} ${row.key ?? ""}`,
					placeholder: "Search keys…",
				}}
			/>
		</Section>
	);
}
