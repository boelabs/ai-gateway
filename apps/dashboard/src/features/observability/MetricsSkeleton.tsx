import { ActivitySkeleton, BreakdownSkeleton } from "./ChartSkeleton";
import { CacheUsageSkeleton } from "./OverviewSkeleton";
import { Section } from "#/shared/components/Section";
import { RangeFilterSkeleton } from "#/shared/components/RangeFilter.tsx";

import {
	StatGridSkeleton,
	ButtonSkeleton,
	TableSkeleton,
	Skeleton,
} from "#/shared/components/Skeleton.tsx";

/** The tables `Metrics` renders, with the headings and headers it gives them. */
const TABLES = [
	{
		title: "By deployment",
		description: "Select one to inspect it. Error rates use finished attempts.",
		headers: [
			"Deployment",
			"Attempts",
			"Tokens",
			"Cache reuse",
			"Error rate",
			"Latency p95",
		],
		toolbar: true,
	},
	{
		title: "By public model",
		description: "Each request counts once, however many attempts it took.",
		headers: [
			"Public model",
			"Requests",
			"Tokens",
			"Errors",
			"Cost",
			"Latency p95",
		],
		toolbar: true,
	},
	{
		title: "By API key",
		description: "Spend per API key or operator, playground included.",
		headers: ["Name", "Requests", "Tokens", "Cache reuse", "Cost"],
		toolbar: true,
		action: true,
	},
	{
		title: "Deployment failures",
		description:
			"Failed attempts, including failures recovered by retries or fallback.",
		headers: ["Deployment", "Failure", "Phase", "Errors"],
		toolbar: false,
	},
];

export function MetricsSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading metrics"
			className="flex flex-col gap-6"
			role="status"
		>
			<div className="flex flex-wrap items-center gap-2">
				<RangeFilterSkeleton period="today" />
				{["13rem", "13rem", "15rem"].map((width, index) => (
					<Skeleton
						className="h-9 rounded-lg"
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed, positional placeholders.
						key={index}
						width={width}
					/>
				))}
			</div>
			<StatGridSkeleton
				className="grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
				count={6}
				icon={false}
				note={false}
			/>
			<div className="grid gap-3 xl:grid-cols-2">
				<ActivitySkeleton source="requests" />
				<ActivitySkeleton source="attempts" />
			</div>
			<CacheUsageSkeleton upstream />
			<BreakdownSkeleton />
			{TABLES.map(({ title, description, headers, toolbar, ...rest }) => (
				<Section
					action={"action" in rest ? <ButtonSkeleton label={6} /> : undefined}
					description={description}
					key={title}
					title={title}
				>
					<TableSkeleton
						headers={headers}
						pagination
						rows={5}
						toolbar={toolbar}
					/>
				</Section>
			))}
		</div>
	);
}
