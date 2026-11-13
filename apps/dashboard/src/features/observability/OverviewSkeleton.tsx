import { TextSkeleton } from "#/shared/components/TextSkeleton";
import { ToggleGroup } from "#/components/ui/toggle-group";
import { Panel } from "#/shared/components/Panel";
import { Toggle } from "#/components/ui/toggle";

import {
	StatGridSkeleton,
	GhostSkeleton,
	Skeleton,
} from "#/shared/components/Skeleton.tsx";

import {
	ReliabilitySkeleton,
	ActivitySkeleton,
	OutcomesSkeleton,
} from "./ChartSkeleton";

/**
 * The overview while its numbers are in flight.
 *
 * Every grid here repeats the real component's own layout classes, so the four tiles, the panels
 * and the two tables are already in their final positions — when the data arrives only the contents
 * of the boxes change, and nothing on the page moves.
 */
export function OverviewSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading overview"
			className="flex flex-col gap-6"
			role="status"
		>
			<StatGridSkeleton count={4} />

			<div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
				<ActivitySkeleton />
				<div className="grid min-w-0 content-start gap-3">
					<OutcomesSkeleton />
					<ReliabilitySkeleton />
				</div>
			</div>

			<CacheUsageSkeleton />
		</div>
	);
}

export function CacheUsageSkeleton({
	upstream = false,
}: {
	upstream?: boolean;
}) {
	return (
		<Panel
			action={
				upstream ? null : (
					<GhostSkeleton>
						<ToggleGroup value={[]}>
							{["By model", "By key"].map((option) => (
								<Toggle
									disabled
									key={option}
									size="xs"
									value={option}
									variant="ghost"
								>
									{option}
								</Toggle>
							))}
						</ToggleGroup>
					</GhostSkeleton>
				)
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
							<TextSkeleton length={5} />
						</span>
						<span className="text-sm">
							<TextSkeleton length={32} />
						</span>
					</p>
					<p className="text-sm">
						<TextSkeleton length={30} />
					</p>
				</div>
				<div aria-hidden className="flex flex-col gap-2.5">
					{(upstream ? [100] : [100, 90, 86]).map((width) => (
						<div className="flex h-7.5 items-center gap-2" key={width}>
							{upstream ? null : (
								<span className="w-[132px] shrink-0 text-right text-xs">
									<TextSkeleton length={10} />
								</span>
							)}
							<Skeleton
								className="h-full rounded-[5px]"
								width={
									upstream ? "calc(100% - 64px)" : `calc(${width}% - 200px)`
								}
							/>
						</div>
					))}
				</div>
				<p className="text-xs">
					<TextSkeleton length={44} />
				</p>
			</div>
		</Panel>
	);
}
