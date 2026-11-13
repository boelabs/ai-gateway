import { Frame, FramePanel } from "#/components/ui/frame";
import { Panel } from "#/shared/components/Panel.tsx";
import { PageHeader } from "#/components/ui/page";
import { Status } from "#/components/ui/status";
import Link from "next/link";

import {
	BreadcrumbSeparator,
	BreadcrumbList,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbPage,
	Breadcrumb,
} from "#/components/ui/breadcrumb";

import { GhostSkeleton, Skeleton } from "#/shared/components/Skeleton.tsx";

import { TextSkeleton } from "#/shared/components/TextSkeleton.tsx";

/**
 * The operation's page while the gateway answers: the same breadcrumb, header, panels and lists,
 * with one attempt (most requests make exactly one) and the payload loading.
 */
export function LogDetailSkeleton() {
	return (
		<>
			<Breadcrumb aria-busy="true">
				<BreadcrumbList>
					<BreadcrumbItem>
						<BreadcrumbLink render={<Link href="/logs" />}>Logs</BreadcrumbLink>
					</BreadcrumbItem>
					<BreadcrumbSeparator />
					<BreadcrumbItem>
						<BreadcrumbPage>
							<TextSkeleton length={8} />
						</BreadcrumbPage>
					</BreadcrumbItem>
				</BreadcrumbList>
			</Breadcrumb>
			<PageHeader
				badge={
					<GhostSkeleton className="rounded-sm">
						<Status tone="success">Success</Status>
					</GhostSkeleton>
				}
				description={<TextSkeleton length={36} />}
				title={<TextSkeleton length={12} />}
			/>
			<div aria-busy="true" className="flex flex-col gap-3">
				<Frame>
					<FramePanel className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
						{["Duration", "First output", "Tokens", "Cost", "Attempts"].map(
							(label) => (
								<div className="flex min-w-0 flex-col gap-1" key={label}>
									<span className="text-sm text-muted-foreground">{label}</span>
									<span className="text-xl font-semibold tracking-tight tabular-nums">
										<TextSkeleton length={5} />
									</span>
								</div>
							),
						)}
					</FramePanel>
				</Frame>
				<Panel title="Attempts">
					<div className="flex gap-3">
						<Skeleton className="mt-1 size-4 shrink-0 rounded-full" />
						<div className="flex min-w-0 flex-1 flex-col gap-1.5">
							<div className="flex items-baseline gap-2 text-sm">
								<TextSkeleton length={10} />
								<span className="ms-auto">
									<TextSkeleton length={6} />
								</span>
							</div>
							<p className="text-xs">
								<TextSkeleton length={48} />
							</p>
						</div>
					</div>
				</Panel>
				<Panel description={<TextSkeleton length={44} />} title="Payload">
					<div aria-hidden className="flex flex-col gap-2">
						{[92, 76, 84, 60].map((width) => (
							<Skeleton
								className="h-3 rounded"
								key={width}
								width={`${width}%`}
							/>
						))}
					</div>
				</Panel>
				<Panel title="Details">
					<dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
						{[
							["Operation ID", 36],
							["Request ID", 36],
							["Actor", 30],
							["Started", 22],
							["Call type", 4],
							["Finish reason", 4],
						].map(([label, length]) => (
							<div className="flex min-w-0 flex-col gap-1" key={label}>
								<dt className="text-xs text-muted-foreground">{label}</dt>
								<dd className="text-sm">
									<TextSkeleton length={Number(length)} />
								</dd>
							</div>
						))}
					</dl>
				</Panel>
			</div>
		</>
	);
}
