"use client";

import { useIdempotencyKey } from "#/shared/lib/useIdempotencyKey.ts";
import { useMemo, useRef, useState, useTransition } from "react";
import { ModelInput } from "#/shared/components/ModelPicker.tsx";
import { FormSkeleton } from "#/shared/components/Skeleton.tsx";
import { useNotify } from "#/shared/feedback/notifications.tsx";
import { LimitField } from "#/shared/components/LimitField.tsx";
import { FormActions } from "#/shared/components/FormActions";
import { SearchableSelect } from "#/components/ui/select";
import { CustomModelEditor } from "./CustomModelEditor";
import { parsePricing, type Pricing } from "./pricing";
import { ArrowCounterClockwiseIcon as IconReset } from "@phosphor-icons/react/dist/ssr";
import { Panel } from "#/shared/components/Panel.tsx";
import { Textarea } from "#/components/ui/textarea";
import { saveDeploymentAction } from "./actions.ts";
import { Button } from "#/components/ui/button";
import { PricingEditor } from "./PricingEditor";
import { Status } from "#/components/ui/status";
import { Switch } from "#/components/ui/switch";
import { Input } from "#/components/ui/input";
import { useRouter } from "next/navigation";
import { Form } from "#/components/ui/form";

import {
	type CreateDeploymentInput,
	isKnownUpstreamModel,
	type AdapterSummary,
	type Deployment,
} from "./common.ts";

import {
	initialCustomEntry,
	selectedTransports,
	parseCustomEntry,
	parseObject,
} from "./custom-model";

const LIST = "/models";

function optionalText(raw: FormDataEntryValue | null): string | undefined {
	const text = String(raw ?? "").trim();
	return text ? text : undefined;
}

/** Zero is "no limit" in the form and `null` at the gateway. */
function limitOrNull(value: number): number | null {
	return value > 0 ? Math.floor(value) : null;
}

const CREDENTIAL_LABELS: Record<string, string> = {
	apiKey: "API key",
	baseUrl: "Base URL",
};

/**
 * A deployment's editor, on its own page: what it serves, how to reach the provider, the model's
 * capabilities when it is not in the catalog, then the optional routing, pricing and metadata —
 * one panel each, with the actions at the foot.
 */
export function DeploymentForm({
	adapters,
	existing,
}: {
	adapters: AdapterSummary[];
	/** Present when editing; the adapter of an existing deployment cannot change. */
	existing?: Deployment;
}) {
	const router = useRouter();
	const notify = useNotify();
	const editing = existing !== undefined;
	const [adapterKey, setAdapterKey] = useState(existing?.adapterKey ?? "");
	const [upstreamModel, setUpstreamModel] = useState(
		existing?.upstreamModel ?? "",
	);
	const [publicModel, setPublicModel] = useState(existing?.publicModel ?? "");
	const [rpmLimit, setRpmLimit] = useState(existing?.rpmLimit ?? 0);
	const [tpmLimit, setTpmLimit] = useState(existing?.tpmLimit ?? 0);
	/** Bumped to clear every pricing field at once when the override is dropped. */
	const [pricingReset, setPricingReset] = useState(0);
	const [customEntry, setCustomEntry] = useState(
		() =>
			existing?.catalogEntry ??
			initialCustomEntry(
				(
					adapters.find((entry) => entry.id === adapterKey)?.operations ?? []
				).map((operation) => operation.id),
			),
	);
	const [technical, setTechnical] = useState<string | null>(null);
	const [transports, setTransports] = useState(
		existing?.transportOverrides ?? {},
	);
	const [pricing, setPricing] = useState<Pricing | undefined>(
		existing?.pricing ?? undefined,
	);
	const [enabled, setEnabled] = useState(existing?.enabled ?? true);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	/** Leaving for the list is a transition: the button stays busy until that page is on screen. */
	const [navigating, startNavigating] = useTransition();
	const submitting = useRef(false);
	const creation = useIdempotencyKey();

	const adapter = useMemo(
		() => adapters.find((entry) => entry.id === adapterKey),
		[adapters, adapterKey],
	);
	const required = adapter?.credentials.required ?? [];
	const catalog = adapter?.models ?? [];
	const known = isKnownUpstreamModel(catalog, upstreamModel);
	const custom = !known;
	const sameStoredModel = existing?.upstreamModel === upstreamModel.trim();
	const catalogTransports = sameStoredModel
		? (existing?.transportOverrides ?? {})
		: {};

	/**
	 * The public model follows the upstream model until the operator names it something else: an
	 * empty name, or one still equal to the previous upstream id, is taken over; any other name was
	 * typed on purpose and stays.
	 */
	function chooseUpstreamModel(next: string) {
		if (
			publicModel.trim() === "" ||
			publicModel.trim() === upstreamModel.trim()
		) {
			setPublicModel(next.trim());
		}
		setUpstreamModel(next);
	}

	/** One snapshot for validation and saving. */
	function readForm(form: FormData): CreateDeploymentInput {
		if (!adapter) {
			throw new Error("Choose an adapter.");
		}
		const credentials: Record<string, unknown> = {};
		for (const field of required) {
			const value = optionalText(form.get(`cred_${field}`));
			if (value !== undefined) {
				credentials[field] = value;
			}
		}
		const extra = parseObject(
			String(form.get("credentialsExtra") ?? ""),
			"Extra credentials",
		);
		if (extra) {
			Object.assign(credentials, extra);
		}
		const entry = custom
			? parseCustomEntry(technical ?? JSON.stringify(customEntry))
			: undefined;
		const rates = parsePricing(pricing);
		const body: CreateDeploymentInput = {
			publicModel: publicModel.trim(),
			adapterKey,
			upstreamModel: upstreamModel.trim(),
			credentials,
			label: optionalText(form.get("label")) ?? null,
			failureDomain: optionalText(form.get("failureDomain")) ?? null,
			metadata:
				parseObject(String(form.get("metadata") ?? ""), "Metadata") ?? {},
			transportOverrides: entry
				? selectedTransports(entry, transports)
				: catalogTransports,
			enabled,
			tpmLimit: limitOrNull(tpmLimit),
			rpmLimit: limitOrNull(rpmLimit),
		};
		if (entry) {
			body.catalogEntry = entry;
		}
		if (rates) {
			body.pricing = rates;
		}
		return body;
	}

	async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (submitting.current) {
			return;
		}
		submitting.current = true;
		setError(null);
		setPending(true);
		try {
			const body = readForm(new FormData(event.currentTarget));
			const result = await saveDeploymentAction(
				body,
				existing?.id,
				creation.key(),
			);
			if (!result.ok) {
				setError(result.message);
				return;
			}
			creation.rotate();
			notify.success(
				editing
					? `${body.publicModel} saved`
					: `${body.upstreamModel} deployed as ${body.publicModel}`,
			);
			startNavigating(() => {
				router.push(LIST);
				router.refresh();
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not save the deployment.",
			);
		} finally {
			submitting.current = false;
			setPending(false);
		}
	}

	return (
		<Form className="flex flex-col gap-3" onSubmit={onSubmit}>
			<Panel
				description="Pick the provider and its model, then the name clients send."
				title="Model"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<SearchableSelect
						disabled={editing}
						items={adapters.map((entry) => ({
							value: entry.id,
							label: entry.id,
						}))}
						label="Adapter"
						name="adapterKey"
						onValueChange={(key) => {
							if (!key || key === adapterKey) {
								return;
							}
							setAdapterKey(key);
							chooseUpstreamModel("");
							setCustomEntry(
								initialCustomEntry(
									(
										adapters.find((entry) => entry.id === key)?.operations ?? []
									).map((operation) => operation.id),
								),
							);
							setTechnical(null);
							setTransports({});
						}}
						placeholder="Choose an adapter"
						required
						searchPlaceholder="Search adapters"
						value={adapterKey || null}
					/>

					{catalog.length > 0 ? (
						/**
						 * A combo box, not a select: the catalog is a strong suggestion, not a closed
						 * set. A dated snapshot ("gpt-5.5-2026-04-23") resolves through its base entry,
						 * and a genuinely new model can be deployed as custom on an adapter that has a
						 * catalog — a select would make both impossible.
						 */
						<ModelInput
							emptyHint="Not in the catalog. Press Enter to use it as a custom model."
							label="Upstream model"
							models={catalog.map((model) => model.id)}
							onChange={chooseUpstreamModel}
							placeholder="Search the catalog or type an id"
							renderItem={(id) => (
								<>
									{id}
									{catalog.find((model) => model.id === id)?.deprecated ? (
										<Status tone="warning">Deprecated</Status>
									) : null}
								</>
							)}
							required
							value={upstreamModel}
						/>
					) : (
						<Input
							disabled={!adapter}
							label="Upstream model"
							onValueChange={chooseUpstreamModel}
							placeholder={
								adapter ? "Enter a model ID" : "Choose an adapter first"
							}
							required
							value={upstreamModel}
						/>
					)}

					<Input
						label="Public model"
						name="publicModel"
						onValueChange={setPublicModel}
						placeholder="Same as the upstream model"
						required
						value={publicModel}
					/>
				</div>
			</Panel>

			<Panel
				description={
					editing
						? "Leave a field blank to keep the stored value."
						: "What the adapter needs to reach the provider."
				}
				title="Credentials"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					{required.map((field) => (
						<Input
							autoComplete="off"
							key={`${adapterKey}:${field}`}
							label={CREDENTIAL_LABELS[field] ?? field}
							name={`cred_${field}`}
							required={!editing}
							type={field === "baseUrl" ? "url" : "password"}
						/>
					))}
					<div className="sm:col-span-2">
						<JsonField
							label="Extra credentials (optional)"
							name="credentialsExtra"
							placeholder='{ "baseUrl": "https://…" }'
							rows={2}
						/>
					</div>
				</div>
			</Panel>

			{custom && upstreamModel.trim() ? (
				<Panel
					description="Not in the adapter's catalog: enable only what the upstream supports."
					title="Custom model"
				>
					<CustomModelEditor
						key={adapterKey}
						onChange={setCustomEntry}
						onTechnicalChange={setTechnical}
						onTransportsChange={setTransports}
						operations={adapter?.operations ?? []}
						technical={technical}
						transports={transports}
						value={customEntry}
					/>
				</Panel>
			) : null}

			<Panel
				action={
					<Switch checked={enabled} onCheckedChange={setEnabled}>
						Enabled
					</Switch>
				}
				description="Traffic is balanced across the deployments of a public model automatically."
				title="Routing"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						defaultValue={existing?.label ?? ""}
						label="Label (optional)"
						name="label"
						placeholder="e.g. primary key, EU region"
					/>
					<Input
						defaultValue={existing?.failureDomain ?? ""}
						label="Shared quota (optional)"
						name="failureDomain"
						placeholder="e.g. openai-main-account"
						title="Deployments with the same value share one provider quota: when one is throttled, all of them back off."
					/>
					<LimitField
						label="Requests per minute"
						onValueChange={setRpmLimit}
						value={rpmLimit}
					/>
					<LimitField
						label="Tokens per minute"
						onValueChange={setTpmLimit}
						step={1000}
						value={tpmLimit}
					/>
				</div>
			</Panel>

			<Panel
				action={
					pricing ? (
						<Button
							onClick={() => {
								setPricingReset((count) => count + 1);
								setPricing(undefined);
							}}
							type="button"
							variant="ghost"
						>
							<IconReset aria-hidden />
							Use catalog pricing
						</Button>
					) : null
				}
				description={
					pricing
						? "USD per million tokens. Replaces every catalog rate; blank rates are not charged."
						: "USD per million tokens. Empty uses the catalog's pricing."
				}
				title="Pricing override"
			>
				<PricingEditor
					key={pricingReset}
					onChange={setPricing}
					value={pricing}
				/>
			</Panel>

			<Panel description="Your own notes, stored as JSON." title="Metadata">
				<div className="flex flex-col gap-4">
					<JsonField
						defaultValue={
							existing?.metadata && Object.keys(existing.metadata).length > 0
								? JSON.stringify(existing.metadata, null, 2)
								: ""
						}
						label="Metadata (optional)"
						name="metadata"
						placeholder='{ "owner": "platform-team" }'
						rows={4}
					/>
					{known && Object.keys(catalogTransports).length > 0 ? (
						<div className="text-sm text-muted-foreground">
							<p>Stored transport overrides (kept as they are):</p>
							<ul className="mt-2 list-inside list-disc">
								{Object.entries(catalogTransports).map(
									([operation, transport]) => (
										<li key={operation}>
											{operation}: {transport}
										</li>
									),
								)}
							</ul>
						</div>
					) : null}
				</div>
			</Panel>
			<FormActions
				cancelHref={LIST}
				error={error}
				pending={pending || navigating}
				submitLabel={editing ? "Save changes" : "Create deployment"}
			/>
		</Form>
	);
}

function JsonField({
	name,
	label,
	placeholder,
	rows,
	defaultValue,
}: {
	name: string;
	label: string;
	placeholder?: string;
	rows: number;
	defaultValue?: string;
}) {
	return (
		<Textarea
			className="resize-y font-mono text-xs"
			defaultValue={defaultValue}
			label={label}
			name={name}
			placeholder={placeholder}
			rows={rows}
			spellCheck={false}
		/>
	);
}

/** The form itself, inert and with its text masked: same panels, same heights, nothing moves. */
export function DeploymentFormSkeleton() {
	return (
		<FormSkeleton>
			<DeploymentForm adapters={[]} />
		</FormSkeleton>
	);
}
