"use client";

import { ScrollArea } from "#/components/ui/primitives/scroll-area";
import {
	CheckIcon as IconCheck,
	CopyIcon as IconCopy,
} from "@phosphor-icons/react/dist/ssr";
import { Breadcrumbs } from "#/shared/components/Breadcrumbs.tsx";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { Frame, FramePanel } from "#/components/ui/frame";
import { ErrorNote, PageHeader } from "#/components/ui/page";
import { Status, outcomeTone } from "#/components/ui/status";
import { useSession } from "#/features/auth/session.tsx";
import { Panel } from "#/shared/components/Panel.tsx";
import type { components } from "#/shared/api/schema";
import { loadPayloadSample } from "./actions.ts";
import { Button } from "#/components/ui/button";
import type { OperationDetail } from "./api.ts";
import { Tabs } from "#/components/ui/tabs";
import { cn } from "#/shared/lib/classes";

import {
	formatDuration,
	formatBytes,
	causeLabel,
	phaseLabel,
	shortId,
} from "./trace.ts";

type Attempt = components["schemas"]["UpstreamAttempt"];
type PayloadState = components["schemas"]["RetainedPayloadState"];
type Json = Record<string, unknown>;

const OUTCOMES: Record<string, string> = {
	success: "Success",
	error: "Error",
	incomplete: "Incomplete",
	cancelled: "Cancelled",
	blocked: "Blocked",
	abandoned: "Abandoned",
};

/** `bad_request` → "Bad request". */
function humanize(code: string): string {
	const words = code.replaceAll("_", " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

function outcomeLabel(outcome: string | null | undefined): string {
	if (!outcome) {
		return "In progress";
	}
	return OUTCOMES[outcome] ?? outcome;
}

const CALL_TYPES: Record<string, string> = {
	chat: "Chat",
	embeddings: "Embeddings",
	rerank: "Rerank",
};

const OWNERS: Record<string, string> = {
	provider: "provider",
	gateway_deadline: "gateway deadline",
	deployment_config: "deployment configuration",
	client: "caller",
	gateway: "gateway",
};

/**
 * A timestamp in the operator's own clock and timezone, which the server does not have: the markup
 * it streamed is expected to differ from what hydration produces here.
 */
function LocalTime({ iso }: { iso: string }) {
	return (
		<time dateTime={iso} suppressHydrationWarning>
			{new Date(iso).toLocaleString(undefined, {
				dateStyle: "medium",
				timeStyle: "medium",
			})}
		</time>
	);
}

function CopyButton({ value, label }: { value: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			aria-label={copied ? "Copied" : label}
			mode="icon"
			onClick={() => {
				navigator.clipboard
					.writeText(value)
					.then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => setCopied(false));
			}}
			title={label}
			variant="ghost"
		>
			{copied ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
		</Button>
	);
}

/**
 * The numbers an operator opens a log for, in one row: how long it took, how soon output came,
 * what it used and what it cost.
 */
function Figures({ items }: { items: { label: string; value: ReactNode }[] }) {
	return (
		<Frame>
			<FramePanel className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
				{items.map((item) => (
					<div className="flex min-w-0 flex-col gap-1" key={item.label}>
						<span className="text-sm text-muted-foreground">{item.label}</span>
						<span className="truncate text-xl font-semibold tracking-tight tabular-nums">
							{item.value}
						</span>
					</div>
				))}
			</FramePanel>
		</Frame>
	);
}

/** What went wrong, in the provider's words, with the gateway's own reading above them. */
function FailureNote({
	title,
	detail,
	message,
	technical,
}: {
	title: string;
	detail?: string | null;
	message?: string | null;
	technical?: string | null;
}) {
	return (
		<div className="flex flex-col gap-1.5 rounded-lg border border-destructive/24 bg-destructive/4 px-3.5 py-3">
			<p className="text-sm font-medium">
				{title}
				{detail ? (
					<span className="font-normal text-muted-foreground"> · {detail}</span>
				) : null}
			</p>
			{message ? (
				<p className="text-sm break-words whitespace-pre-wrap">{message}</p>
			) : null}
			{technical ? (
				<p className="font-mono text-xs break-words whitespace-pre-wrap text-muted-foreground">
					{technical}
				</p>
			) : null}
		</div>
	);
}

/**
 * One upstream attempt as a step on a vertical timeline: the deployment and how long it took on the
 * first line, its timings on the second, and the provider's answer when it failed. The order is the
 * story — a retry is simply the next step — so no bar chart is needed to tell it.
 */
function AttemptStep({
	attempt,
	operationStart,
	last,
}: {
	attempt: Attempt;
	operationStart: number;
	last: boolean;
}) {
	const failed = attempt.outcome === "error";
	const provider = attempt.error?.provider;
	const diagnostics = (attempt.diagnostics ?? {}) as Json;
	const offset = Math.max(0, Date.parse(attempt.startedAt) - operationStart);
	const timings = [
		offset > 0 ? `started +${formatDuration(offset)}` : null,
		attempt.headersMs === null
			? null
			: `headers ${formatDuration(attempt.headersMs)}`,
		attempt.firstOutputMs === null
			? null
			: `first output ${formatDuration(attempt.firstOutputMs)}`,
		attempt.totalTokens === null
			? null
			: `${attempt.totalTokens.toLocaleString()} tokens`,
		attempt.upstreamBytes === null ? null : formatBytes(attempt.upstreamBytes),
		typeof diagnostics.terminalReason === "string"
			? `finish ${diagnostics.terminalReason}`
			: null,
	].filter(Boolean);
	return (
		<li className="relative flex gap-3 pb-6 last:pb-0">
			{last ? null : (
				<span
					aria-hidden
					className="absolute start-[7px] top-6 bottom-1 w-px bg-border"
				/>
			)}
			<span
				aria-hidden
				className={cn(
					"relative mt-1 size-4 shrink-0 rounded-full border-4 border-background ring-1",
					failed
						? "bg-destructive ring-destructive/40"
						: "bg-success ring-success/40",
				)}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<span className="text-sm font-medium">
						{attempt.deploymentLabel ??
							(attempt.deploymentId ? shortId(attempt.deploymentId) : "—")}
					</span>
					<span className="font-mono text-xs text-muted-foreground">
						{[attempt.adapterKey, attempt.upstreamModel]
							.filter(Boolean)
							.join(" · ")}
					</span>
					<span className="ms-auto text-sm font-medium tabular-nums">
						{formatDuration(attempt.durationMs)}
					</span>
				</div>
				<p className="text-xs text-muted-foreground tabular-nums">
					Attempt {attempt.ordinal} · {timings.join(" · ")}
				</p>
				{failed ? (
					<FailureNote
						detail={[
							OWNERS[attempt.failureOwner ?? ""],
							phaseLabel(attempt.failurePhase),
						]
							.filter(Boolean)
							.join(" · ")}
						message={provider?.message ?? attempt.error?.message ?? null}
						technical={
							[
								provider?.type && `type ${provider.type}`,
								provider?.code && `code ${provider.code}`,
								provider?.param && `param ${provider.param}`,
							]
								.filter(Boolean)
								.join(" · ") || null
						}
						title={causeLabel({
							owner: attempt.failureOwner,
							phase: attempt.failurePhase,
							kind: attempt.failureKind,
							providerStatus: attempt.providerStatus,
						})}
					/>
				) : null}
			</div>
		</li>
	);
}

const PAYLOAD_PARTS = [
	["request", "Request"],
	["response", "Response"],
	["error", "Error"],
	["attempts", "Attempts"],
] as const;

function asText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * The retained request and response, loaded with the page for a role that may read them, one tab
 * per part. Each read is still recorded in the gateway's payload access audit.
 */
function Payload({
	operationId,
	sample,
}: {
	operationId: string;
	sample: PayloadState;
}) {
	const { can } = useSession();
	const allowed = can("payloads:read") && sample.readable;
	const [payload, setPayload] = useState<Json | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<string>("request");

	useEffect(() => {
		if (!allowed) {
			return;
		}
		let live = true;
		loadPayloadSample(operationId).then((result) => {
			if (!live) {
				return;
			}
			if (result.ok) {
				setPayload(result.data);
			} else {
				setError(result.message);
			}
		});
		return () => {
			live = false;
		};
	}, [allowed, operationId]);

	const parts = PAYLOAD_PARTS.filter(
		([key]) => payload?.[key] !== undefined && payload?.[key] !== null,
	);
	const active = parts.find(([key]) => key === tab) ?? parts[0];
	const text = active ? asText(payload?.[active[0]]) : "";

	let body: ReactNode;
	if (sample.access === "sealed") {
		body =
			"Payloads are sealed on this gateway: they are kept encrypted and no operator can read them.";
	} else if (!sample.retained) {
		body =
			"Nothing retained for this request: its retention window has passed.";
	} else if (!allowed) {
		body = "Your role cannot read payloads.";
	} else if (error) {
		body = <ErrorNote>{error}</ErrorNote>;
	} else if (!payload) {
		body = (
			<div aria-busy="true" className="flex flex-col gap-2" role="status">
				<span className="sr-only">Loading the payload</span>
				{[92, 76, 84, 60].map((width) => (
					<span
						aria-hidden
						className="h-3 animate-pulse rounded bg-muted motion-reduce:animate-none"
						key={width}
						style={{ width: `${width}%` }}
					/>
				))}
			</div>
		);
	}

	return (
		<Panel
			action={
				active ? (
					<CopyButton label={`Copy ${active[1].toLowerCase()}`} value={text} />
				) : null
			}
			description={
				sample.retained && sample.expiresAt ? (
					<>
						Viewing it is audited · kept until{" "}
						<LocalTime iso={sample.expiresAt} />
					</>
				) : undefined
			}
			flush={Boolean(active)}
			title="Payload"
		>
			{active ? (
				<Tabs.Root
					onValueChange={(value) => setTab(String(value))}
					value={active[0]}
				>
					<div className="border-b p-3">
						<Tabs.List>
							{parts.map(([key, label]) => (
								<Tabs.Tab key={key} value={key}>
									{label}
								</Tabs.Tab>
							))}
						</Tabs.List>
					</div>
					<ScrollArea
						className="h-auto"
						scrollFade
						viewportClassName="max-h-[36rem]"
					>
						<pre className="p-5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
							{text}
						</pre>
					</ScrollArea>
				</Tabs.Root>
			) : (
				<div className="text-sm text-muted-foreground">{body}</div>
			)}
		</Panel>
	);
}

/** A labelled value in the details grid; a missing value is left out rather than dashed. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
	if (children === null || children === undefined || children === "") {
		return null;
	}
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-sm">{children}</dd>
		</div>
	);
}

function Identifier({ value, label }: { value: string; label: string }) {
	return (
		<span className="-my-2 flex min-w-0 items-center gap-1">
			<span className="truncate font-mono text-xs">{value}</span>
			<CopyButton label={label} value={value} />
		</span>
	);
}

/**
 * Everything the gateway recorded about one request, top to bottom in the order an operator asks:
 * how it went (the figures), what failed, which deployments it went through, what was sent and
 * received, and the identifiers to quote.
 */
export function LogDetail({ detail }: { detail: OperationDetail }) {
	const { attempts } = detail;
	const opError = detail.error;
	const operationStart = Date.parse(detail.startedAt);
	const metadata = (detail.metadata ?? {}) as Json;
	const terminal = (metadata.terminal ??
		(metadata.streamLifecycle as Json | undefined)?.terminal) as
		| Json
		| null
		| undefined;
	const costCents = Number(detail.consumerCostCents ?? 0);
	const callType = CALL_TYPES[detail.callType] ?? detail.callType;
	const tokens =
		typeof detail.totalTokens === "number"
			? detail.totalTokens.toLocaleString()
			: "—";

	return (
		<>
			<Breadcrumbs
				items={[
					{ label: "Logs", href: "/logs" },
					{ label: shortId(detail.id) },
				]}
				recent={`${detail.publicModel ?? detail.callType} · ${shortId(detail.id)}`}
			/>
			<PageHeader
				badge={
					<>
						<Status tone={outcomeTone(detail.outcome)}>
							{outcomeLabel(detail.outcome)}
						</Status>
						{detail.stream ? <Status tone="muted">Stream</Status> : null}
					</>
				}
				description={
					<>
						{callType}
						{detail.httpStatus === null ? "" : ` · HTTP ${detail.httpStatus}`} ·{" "}
						<LocalTime iso={detail.startedAt} />
					</>
				}
				title={
					<span className="break-all">
						{detail.publicModel ?? detail.callType}
					</span>
				}
			/>

			<div className="flex flex-col gap-3">
				<Figures
					items={[
						{ label: "Duration", value: formatDuration(detail.durationMs) },
						{
							label: "First output",
							value:
								detail.firstOutputMs === null
									? "—"
									: formatDuration(detail.firstOutputMs),
						},
						{ label: "Tokens", value: tokens },
						{
							label: "Cost",
							value: costCents > 0 ? `$${(costCents / 100).toFixed(4)}` : "—",
						},
						{ label: "Attempts", value: String(attempts.length) },
					]}
				/>

				{opError ? (
					<FailureNote
						detail={`HTTP ${String(opError.http_status ?? "?")} to the caller`}
						message={
							typeof opError.message === "string" ? opError.message : null
						}
						title={humanize(String(opError.code ?? opError.class ?? "error"))}
					/>
				) : null}

				<Panel title="Attempts">
					{attempts.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							No upstream was contacted: the request never left the gateway.
						</p>
					) : (
						<ol className="flex flex-col">
							{attempts.map((attempt, index) => (
								<AttemptStep
									attempt={attempt}
									key={attempt.id}
									last={index === attempts.length - 1}
									operationStart={operationStart}
								/>
							))}
						</ol>
					)}
				</Panel>

				<Suspense
					fallback={
						<Panel title="Payload">
							<span className="sr-only">Loading</span>
						</Panel>
					}
				>
					<Payload operationId={detail.id} sample={detail.payload} />
				</Suspense>

				<Panel title="Details">
					<dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
						<Detail label="Operation ID">
							<Identifier label="Copy operation ID" value={detail.id} />
						</Detail>
						<Detail label="Request ID">
							<Identifier label="Copy request ID" value={detail.requestId} />
						</Detail>
						<Detail label="Actor">
							{typeof detail.actor === "string" ? (
								<span className="block truncate font-mono text-xs">
									{detail.actor}
								</span>
							) : null}
						</Detail>
						<Detail label="Started">
							<LocalTime iso={detail.startedAt} />
						</Detail>
						<Detail label="Call type">{callType}</Detail>
						<Detail label="Finish reason">
							{typeof terminal?.reason === "string" ? terminal.reason : null}
						</Detail>
					</dl>
				</Panel>
			</div>
		</>
	);
}
