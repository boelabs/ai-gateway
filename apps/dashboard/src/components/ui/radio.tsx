"use client";

import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { Radio as BaseRadio } from "@base-ui/react/radio";
import type { ReactNode } from "react";

import {
	type AppearanceProps,
	type ControlProps,
	type UIVariant,
	mergeClassName,
	mergeStyle,
	focusRing,
} from "./appearance";

const sizes = { xs: "size-3.5", sm: "size-4", md: "size-5", lg: "size-6" };
/** The unchecked surface; the checked state overrides the border below. */
const surfaces: Record<UIVariant, string> = {
	filled: "border-transparent bg-surface-2",
	ghost: "border-transparent bg-transparent",
	outlined: "border-border bg-surface",
};
function Root({
	className,
	style,
	borderRadius,
	width,
	size = "md",
	variant = "outlined",
	...props
}: BaseRadio.Root.Props & ControlProps) {
	return (
		<BaseRadio.Root
			{...props}
			className={mergeClassName(
				`${focusRing} ${sizes[size]} inline-flex shrink-0 items-center justify-center rounded-full border ${surfaces[variant]} data-disabled:cursor-not-allowed data-checked:border-primary data-disabled:opacity-50`,
				className,
			)}
			style={mergeStyle({ borderRadius, width }, style)}
		/>
	);
}
function Indicator({
	className,
	style,
	borderRadius,
	width,
	...props
}: BaseRadio.Indicator.Props & AppearanceProps) {
	return (
		<BaseRadio.Indicator
			{...props}
			className={mergeClassName("size-1/2 rounded-full bg-primary", className)}
			style={mergeStyle({ borderRadius, width }, style)}
		/>
	);
}
export function RadioGroup({
	className,
	style,
	borderRadius,
	width,
	...props
}: BaseRadioGroup.Props & AppearanceProps) {
	return (
		<BaseRadioGroup
			{...props}
			className={mergeClassName("flex flex-col gap-3", className)}
			style={mergeStyle({ borderRadius, width }, style)}
		/>
	);
}
export const Radio = { Root, Indicator };

/**
 * coss UI's card radio: the whole card is the hit target, the title and description sit beside the
 * dot, and the chosen card takes the primary border. Use it for a choice between a few options that
 * each need a sentence, instead of a switch whose two states mean different things.
 */
export function RadioCard({
	value,
	title,
	description,
	disabled,
}: {
	value: string;
	title: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the Base UI radio inside is the control.
		<label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-background p-3.5 transition-colors hover:bg-accent/50 has-data-checked:border-primary/48 has-data-checked:bg-accent/50 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-64">
			<Root
				className="mt-0.5 border-input"
				disabled={disabled}
				size="sm"
				value={value}
			>
				<Indicator />
			</Root>
			<span className="flex min-w-0 flex-col gap-0.5">
				<span className="text-sm font-medium">{title}</span>
				{description ? (
					<span className="text-sm text-muted-foreground">{description}</span>
				) : null}
			</span>
		</label>
	);
}
