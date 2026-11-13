import { MetricsSkeleton } from "#/features/observability/MetricsSkeleton.tsx";
import { RefreshControls } from "#/shared/components/RefreshControls.tsx";
import { MetricsView } from "#/features/observability/MetricsView.tsx";
import { RouteBoundary } from "#/shared/components/RouteBoundary.tsx";
import { detailedMetrics, usage } from "#/features/observability/api.ts";
import { listKeys } from "#/features/keys/api.ts";
import { PageHeader } from "#/components/ui/page";
import { connection } from "next/server";
import { Suspense } from "react";

import {
	metricsSearch,
	metricsWindow,
} from "#/features/observability/metrics-data.ts";

/**
 * Detailed metrics for a chosen window.
 *
 * One boundary rather than the header/body split the other pages use: the model and deployment
 * pickers are built from the metrics response, so the controls have nothing to show until the query
 * returns. `metricsWindow` throws on an impossible range — a custom window running backwards, or
 * longer than a month — and that message is what the boundary shows, next to a way out of it.
 */
export default function MetricsPage(props: PageProps<"/metrics">) {
	return (
		<>
			{/* The only heading this page has. `Metrics` renders the body alone, so the title and
			    the refresh control paint with the shell rather than waiting on the query. */}
			<PageHeader
				actions={<RefreshControls />}
				description="Explore consumption, performance and reliability across public models and deployments."
				title="Metrics"
			/>
			<RouteBoundary resetHref="/metrics" title="Metrics could not be loaded">
				<Suspense fallback={<MetricsSkeleton />}>
					<Window searchParams={props.searchParams} />
				</Suspense>
			</RouteBoundary>
		</>
	);
}

async function Window({
	searchParams,
}: {
	searchParams: PageProps<"/metrics">["searchParams"];
}) {
	const search = metricsSearch.parse(await searchParams);
	// `metricsWindow` anchors relative periods ("today", "7d") to now, which a prerender has no value
	// for. `connection()` says so: this renders when a real request arrives, not at build time.
	await connection();
	const window = metricsWindow(search);
	const base = { ...window, operation: search.operation };
	const filtered = {
		...base,
		publicModel: search.publicModel,
		deploymentId: search.deploymentId,
	};
	/**
	 * The unfiltered query only runs when a filter is set, and only to keep the pickers populated:
	 * narrowing to one model must not remove every other model from the list that narrowed it.
	 */
	const [data, options, actors, names] = await Promise.all([
		detailedMetrics(filtered),
		search.publicModel || search.deploymentId
			? detailedMetrics(base)
			: Promise.resolve(null),
		// Usage accepts an inclusive end; the metrics window is [start, end).
		usage({
			groupBy: "actor",
			start: window.start,
			end: new Date(Date.parse(window.end) - 1).toISOString(),
		}),
		keyNames(),
	]);
	return (
		<MetricsView
			actors={actors}
			data={data}
			keyNames={names}
			options={options ?? data}
			search={search}
		/>
	);
}

/**
 * Key names for the usage table. A role that cannot read keys gets none, and the table falls back
 * to short ids: names are a courtesy, never a reason to fail the page.
 */
async function keyNames(): Promise<Record<string, string>> {
	try {
		const { data } = await listKeys({ limit: 200 });
		return Object.fromEntries(data.map((key) => [key.id, key.name]));
	} catch {
		return {};
	}
}
