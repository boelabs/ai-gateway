"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
	PlusIcon as IconPlus,
	TrashIcon as IconTrash,
} from "@phosphor-icons/react/dist/ssr";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";

import {
	type PricingRateField,
	PRICING_RATE_FIELDS,
	type PricingTier,
	type Pricing,
} from "./pricing";

/** The unit is said once, in the panel's description; each label names only the rate. */
const RATE_LABELS: Record<PricingRateField, string> = {
	inputCentsPerMTokens: "Input",
	outputCentsPerMTokens: "Output",
	cacheReadCentsPerMTokens: "Cache read",
	cacheWriteCentsPerMTokens: "Cache write",
	imageInputCentsPerMTokens: "Image input",
	imageOutputCentsPerMTokens: "Image output",
	audioInputCentsPerMTokens: "Audio input",
	audioOutputCentsPerMTokens: "Audio output",
	videoOutputCentsPerMTokens: "Video output",
	searchUnitCents: "Search (per call)",
};
const TIER_FIELDS = PRICING_RATE_FIELDS.filter(
	(field) =>
		field !== "searchUnitCents" && field !== "videoOutputCentsPerMTokens",
);

/** Operators think in dollars per million tokens; the gateway stores cents. */
function centsToDollars(cents: number | undefined): number | undefined {
	return cents === undefined ? undefined : cents / 100;
}
function dollarsToCents(dollars: number | undefined): number | undefined {
	return dollars === undefined
		? undefined
		: Math.round(dollars * 100 * 1e6) / 1e6;
}

function NumberInput({
	value,
	onChange,
	validate,
	...props
}: {
	value: number | undefined;
	onChange: (value: number | undefined) => void;
	validate?: (value: number) => string;
	label: string;
	min?: number;
	step?: number | "any";
	placeholder?: string;
	required?: boolean;
}) {
	const [draft, setDraft] = useState(value === undefined ? "" : String(value));
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		// Keep what is being typed ("0.10") when it already means the value; otherwise follow it.
		setDraft((current) => {
			if (current !== "" && Number(current) === value) {
				return current;
			}
			return value === undefined ? "" : String(value);
		});
	}, [value]);
	useEffect(() => {
		ref.current?.setCustomValidity(
			draft ? (validate?.(Number(draft)) ?? "") : "",
		);
	}, [draft, validate]);
	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget;
		setDraft(input.value);
		input.setCustomValidity(
			input.value ? (validate?.(Number(input.value)) ?? "") : "",
		);
		if (!input.validity.badInput) {
			onChange(input.value === "" ? undefined : Number(input.value));
		}
	}
	return (
		<Input
			{...props}
			inputMode="decimal"
			onChange={handleChange}
			ref={ref}
			type="number"
			value={draft}
		/>
	);
}

function DollarRate({
	field,
	value,
	onChange,
}: {
	field: PricingRateField;
	value: number | undefined;
	onChange: (cents: number | undefined) => void;
}) {
	return (
		<NumberInput
			label={RATE_LABELS[field]}
			min={0}
			onChange={(dollars) => onChange(dollarsToCents(dollars))}
			placeholder="0.00"
			step="any"
			value={centsToDollars(value)}
		/>
	);
}

/**
 * A deployment's own rates, in USD per million tokens. Resetting to the catalog is the panel's
 * action, so this editor only edits; its parent remounts it to clear every field at once.
 */
export function PricingEditor({
	value,
	onChange,
}: {
	value: Pricing | undefined;
	onChange: (value: Pricing | undefined) => void;
}) {
	const tiers = value?.tiers ?? [];
	const nextId = useRef(tiers.length);
	const [tierIds, setTierIds] = useState(() => tiers.map((_, index) => index));
	function emit(next: Pricing) {
		onChange(Object.keys(next).length === 0 ? undefined : next);
	}
	function updateRate(field: PricingRateField, rate: number | undefined) {
		const next = { ...value };
		if (rate === undefined) {
			delete next[field];
		} else {
			next[field] = rate;
		}
		emit(next);
	}
	function updateTier(index: number, patch: Partial<PricingTier>) {
		emit({
			...value,
			tiers: tiers.map((tier, i) =>
				i === index ? { ...tier, ...patch } : tier,
			),
		});
	}
	function addTier() {
		const taken = new Set(tiers.map((tier) => tier.aboveInputTokens));
		let threshold = 200_000;
		while (taken.has(threshold)) {
			threshold += 1;
		}
		setTierIds([...tierIds, nextId.current++]);
		emit({ ...value, tiers: [...tiers, { aboveInputTokens: threshold }] });
	}
	function removeTier(index: number) {
		setTierIds(tierIds.filter((_, i) => i !== index));
		const next = { ...value };
		const remaining = tiers.filter((_, i) => i !== index);
		if (remaining.length) {
			next.tiers = remaining;
		} else {
			delete next.tiers;
		}
		emit(next);
	}
	return (
		<div className="flex flex-col gap-6">
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{PRICING_RATE_FIELDS.map((field) => (
					<DollarRate
						field={field}
						key={field}
						onChange={(rate) => updateRate(field, rate)}
						value={value?.[field]}
					/>
				))}
			</div>

			<div className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 flex-col">
						<h4 className="text-sm font-medium">Context tiers</h4>
						<p className="text-sm text-muted-foreground">
							Whole-request rates once the input passes a token threshold.
						</p>
					</div>
					<Button onClick={addTier} type="button" variant="secondary">
						<IconPlus aria-hidden />
						Add tier
					</Button>
				</div>
				{tiers.map((tier, index) => (
					<div
						className="flex min-w-0 flex-col gap-4 rounded-xl border bg-muted/40 p-4"
						key={tierIds[index]}
					>
						<div className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<NumberInput
									label="Above input tokens"
									min={1}
									onChange={(threshold) => {
										if (threshold !== undefined) {
											updateTier(index, { aboveInputTokens: threshold });
										}
									}}
									required
									step={1}
									validate={(threshold) =>
										tiers.some(
											(other, i) =>
												i !== index && other.aboveInputTokens === threshold,
										)
											? "Each threshold must be unique."
											: ""
									}
									value={tier.aboveInputTokens}
								/>
							</div>
							<Button
								aria-label={`Remove context tier ${index + 1}`}
								mode="icon"
								onClick={() => removeTier(index)}
								type="button"
								variant="ghost"
							>
								<IconTrash aria-hidden />
							</Button>
						</div>
						<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
							{TIER_FIELDS.map((field) => (
								<DollarRate
									field={field}
									key={field}
									onChange={(rate) => {
										const next = { ...tier };
										if (rate === undefined) {
											delete next[field];
										} else {
											next[field] = rate;
										}
										emit({
											...value,
											tiers: tiers.map((existing, i) =>
												i === index ? next : existing,
											),
										});
									}}
									value={tier[field]}
								/>
							))}
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
