"use client";

import { Frame, FramePanel, FrameFooter } from "#/components/ui/frame";
import type { StatusProps } from "#/components/ui/status";
import { Status } from "#/components/ui/status";
import type { LucideIcon } from "lucide-react";

export interface StatNote {
	text: string;
	tone?: StatusProps["tone"];
	exact?: string;
}
export function StatCard({
	label,
	value,
	exact,
	icon: Icon,
	note,
	detail,
}: {
	label: string;
	value: string;
	exact?: string;
	icon?: LucideIcon;
	note?: StatNote;
	detail: string;
}) {
	return (
		<Frame className="min-w-0">
			<FramePanel className="flex flex-1 flex-col gap-2 p-4">
				<div className="flex items-start justify-between gap-2">
					<h2 className="text-xs text-muted-foreground">{label}</h2>
					{Icon ? (
						<Icon
							aria-hidden
							className="size-4 shrink-0 text-muted-foreground"
						/>
					) : null}
				</div>
				<p
					className="text-2xl font-semibold text-foreground tabular-nums"
					title={exact}
				>
					{value}
				</p>
			</FramePanel>
			<FrameFooter className="flex min-w-0 items-center gap-2 px-3 pt-2 pb-1.5 text-xs text-muted-foreground">
				{note ? (
					<Status
						className="shrink-0"
						title={note.exact}
						tone={note.tone ?? "neutral"}
					>
						{note.text}
					</Status>
				) : null}
				<span className="truncate" title={detail}>
					{detail}
				</span>
			</FrameFooter>
		</Frame>
	);
}
