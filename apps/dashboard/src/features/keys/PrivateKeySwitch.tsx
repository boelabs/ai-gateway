"use client";

import { RadioCard, RadioGroup } from "#/components/ui/radio";

const STORED = "stored";
const PRIVATE = "private";

/**
 * The one choice a key's secret has: keep it, sealed, so it can be copied again, or show it once
 * and keep nothing. Shared by issuing a key and regenerating one, so both ask it in the same words.
 * Two cards rather than a switch: both answers are legitimate, and each needs its consequence.
 */
export function PrivateKeySwitch({
	checked,
	disabled,
	onCheckedChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<RadioGroup
			aria-label="Secret storage"
			className="grid gap-3 sm:grid-cols-2"
			{...(disabled === undefined ? {} : { disabled })}
			onValueChange={(value) => onCheckedChange(value === PRIVATE)}
			value={checked ? PRIVATE : STORED}
		>
			<RadioCard
				description="Stored encrypted, so you can copy it again later."
				title="Copyable"
				value={STORED}
			/>
			<RadioCard
				description="Shown once and never stored. Losing it means regenerating the key."
				title="Show once"
				value={PRIVATE}
			/>
		</RadioGroup>
	);
}
