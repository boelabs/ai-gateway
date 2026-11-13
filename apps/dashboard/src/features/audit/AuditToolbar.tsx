"use client";

import { ListToolbar, ListSelect } from "#/shared/components/ListToolbar.tsx";
import { ALL, AUDIT_PERIODS, DEFAULT_PERIOD, KINDS } from "./filters.ts";
import {
	RangeFilterSkeleton,
	RangeFilter,
} from "#/shared/components/RangeFilter.tsx";
import { useSearchWriter } from "#/shared/lib/useSearchWriter.ts";
import { SearchField } from "#/shared/components/SearchField.tsx";
import { GhostSkeleton } from "#/shared/components/Skeleton.tsx";
import { type AuditFilters, isFiltered } from "./filters.ts";
import { createTableRows } from "#/shared/lib/tableRows.tsx";
import { downloadCsv } from "#/shared/lib/csv.ts";
import { Button } from "#/components/ui/button";
import type { AuditEntry } from "./api.ts";
import type { ReactNode } from "react";

import {
	FunnelXIcon as IconFilterOff,
	DownloadSimpleIcon as IconDownload,
} from "@phosphor-icons/react/dist/ssr";

const KIND_OPTIONS = [
	{ value: ALL, label: "All entries" },
	...Object.entries(KINDS).map(([value, label]) => ({ value, label })),
];

/** The entries the table shows, for *Export*: the toolbar and the table load separately. */
const auditRows = createTableRows<AuditEntry>();

/** Wraps the toolbar and the table, so *Export* can read the entries on screen. */
export function AuditRows({ children }: { children: ReactNode }) {
	return <auditRows.Provider>{children}</auditRows.Provider>;
}

export const usePublishAuditRows = auditRows.usePublishRows;

/** The current page of entries as CSV: what is on screen is what is filtered and understood. */
function ExportButton() {
	const rows = auditRows.useTableRows();
	return (
		<Button
			disabled={!rows?.length}
			onClick={() => {
				if (!rows) {
					return;
				}
				downloadCsv(
					`audit-${new Date().toISOString().slice(0, 10)}.csv`,
					rows,
					[
						["at", (row) => row.at],
						["kind", (row) => row.kind],
						["actor", (row) => row.actor],
						["action", (row) => row.action],
						["targetType", (row) => row.targetType],
						["targetId", (row) => row.targetId],
						["status", (row) => row.status],
						["ip", (row) => row.ip],
						["requestId", (row) => row.requestId],
					],
				);
			}}
			variant="secondary"
		>
			<IconDownload aria-hidden className="size-4" />
			Export
		</Button>
	);
}

/** A control's ghost while the page loads; `grow` for the ones that fill a phone's row. */
function Ghost({
	loading,
	grow = false,
	children,
}: {
	loading: boolean;
	grow?: boolean;
	children: ReactNode;
}) {
	if (!loading) {
		return children;
	}
	return (
		<GhostSkeleton
			className={grow ? "min-w-0 flex-1 @min-[40rem]:flex-none" : undefined}
		>
			{children}
		</GhostSkeleton>
	);
}

/**
 * The filters: the period and kind on one side; the searches and *Export* on the other. `filters`
 * comes from the page, which parsed the URL with the same schema the loader used — see
 * `shared/lib/useSearchWriter.ts` for why the controls do not read it themselves. `loading` draws
 * the same toolbar as ghosts for the page's fallback.
 */
export function AuditToolbar({
	filters,
	loading = false,
}: {
	filters: AuditFilters;
	loading?: boolean;
}) {
	const { filter, clear } = useSearchWriter(filters);
	const toolbar = (
		<ListToolbar
			controls={
				<>
					<Ghost grow loading={loading}>
						<SearchField
							label="Filter by actor"
							onSearch={(value) => filter({ actor: value })}
							placeholder="Actor"
							value={filters.actor ?? ""}
						/>
					</Ghost>
					<Ghost grow loading={loading}>
						<SearchField
							label="Filter by action"
							onSearch={(value) => filter({ action: value })}
							placeholder="DELETE, /admin/keys…"
							value={filters.action ?? ""}
						/>
					</Ghost>
					{isFiltered(filters) ? (
						<Button onClick={() => clear()} variant="ghost">
							<IconFilterOff aria-hidden className="size-4" />
							Clear filters
						</Button>
					) : null}
					<Ghost loading={loading}>
						<ExportButton />
					</Ghost>
				</>
			}
			selects={
				<>
					{loading ? (
						<RangeFilterSkeleton period={DEFAULT_PERIOD} />
					) : (
						<RangeFilter
							fallback={DEFAULT_PERIOD}
							onChange={(patch) => filter(patch)}
							periods={AUDIT_PERIODS}
							value={filters}
						/>
					)}
					<Ghost grow loading={loading}>
						<ListSelect
							kind="segment"
							label="Filter by kind"
							onValueChange={(key) =>
								filter({ kind: key === ALL ? undefined : key })
							}
							options={KIND_OPTIONS}
							value={filters.kind ?? ALL}
						/>
					</Ghost>
				</>
			}
		/>
	);
	return loading ? (
		<div aria-hidden="true" inert>
			{toolbar}
		</div>
	) : (
		toolbar
	);
}
