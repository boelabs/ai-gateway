"use client";

import { NumberField } from "#/components/ui/number-field";
import { labelStyles } from "#/components/ui/appearance";
import { Badge } from "#/components/ui/badge";
import { useId } from "react";

/**
 * A ceiling the operator may set: a whole number from zero up, where zero means no ceiling. The
 * field never sits empty and never takes a negative, and an unset ceiling says so beside its label
 * instead of in a line of help under it.
 */
export function LimitField({
	label,
	name,
	value,
	onValueChange,
	step = 1,
	decimals = 0,
	disabled,
}: {
	label: string;
	/** Submitted with the form when set; controlled callers may leave it out. */
	name?: string;
	value: number;
	onValueChange: (value: number) => void;
	step?: number;
	/** Fraction digits the field keeps, e.g. 2 for dollars. */
	decimals?: number;
	disabled?: boolean;
}) {
	const id = useId();
	return (
		<NumberField.Root
			disabled={disabled}
			format={{ maximumFractionDigits: decimals, useGrouping: true }}
			min={0}
			{...(name === undefined ? {} : { name })}
			onValueChange={(next) => onValueChange(next ?? 0)}
			step={step}
			value={value}
		>
			<div className="flex h-4.5 items-center justify-between gap-2 sm:h-4">
				<label className={labelStyles} htmlFor={id}>
					{label}
				</label>
				{value === 0 ? (
					<Badge size="sm" variant="neutral">
						Unlimited
					</Badge>
				) : null}
			</div>
			<NumberField.Group>
				<NumberField.Input className="px-3 text-left" id={id} />
			</NumberField.Group>
		</NumberField.Root>
	);
}
