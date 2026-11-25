"use client";

import { Select, SelectItem } from "#/components/ui/select";
import { type ImageSettings, withImageSetting, imageChoices } from "./images";
import { NumberField } from "#/components/ui/number-field";
import { buttonStyles } from "#/components/ui/button";
import type { ImageOptions } from "./models";

import {
	DialogDescription,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogClose,
	DialogTitle,
	DialogBody,
	DialogRoot,
} from "#/components/ui/dialog";

const DEFAULT = "default";

/**
 * One optional control.
 *
 * "Default" is not a value the gateway is told about — it is the absence of one. Image models
 * disagree about which sizes, qualities and formats exist, and the catalog does not describe them
 * per model, so sending a parameter nobody chose is how an operator gets a rejection they did not
 * ask for.
 */
function Optional({
	label,
	description,
	value,
	values,
	onChange,
}: {
	label: string;
	description?: string;
	value: string | undefined;
	values: readonly string[];
	onChange: (value: string | undefined) => void;
}) {
	return (
		<Select
			label={label}
			{...(description ? { description } : {})}
			onValueChange={(next) =>
				onChange(next === DEFAULT || next === null ? undefined : next)
			}
			value={value ?? DEFAULT}
		>
			<SelectItem value={DEFAULT}>Default</SelectItem>
			{values.map((entry) => (
				<SelectItem key={entry} value={entry}>
					{entry}
				</SelectItem>
			))}
		</Select>
	);
}

export function ImageSettingsDialog({
	open,
	onOpenChange,
	settings,
	onSettings,
	canEdit,
	options,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	settings: ImageSettings;
	onSettings: (settings: ImageSettings) => void;
	/** Whether this model can edit, which is what makes the size control conditional. */
	canEdit: boolean;
	/** What the selected model takes; only those values are offered. */
	options: ImageOptions | undefined;
}) {
	const choices = imageChoices(options, canEdit);
	function set<Key extends keyof ImageSettings>(
		key: Key,
		value: ImageSettings[Key],
	) {
		onSettings(withImageSetting(settings, key, value));
	}
	return (
		<DialogRoot onOpenChange={onOpenChange} open={open}>
			<DialogContent className="md:w-xl" layout="sectioned">
				<DialogHeader>
					<DialogTitle>Image settings</DialogTitle>
					<DialogDescription>
						Anything left on Default is not sent, so the model applies its own.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<div className="grid gap-4 sm:grid-cols-2">
						{choices.sizes.length ? (
							<Optional
								label="Size"
								{...(canEdit
									? {
											description:
												"Generation only; an edit keeps the source size.",
										}
									: {})}
								onChange={(value) => set("size", value)}
								value={settings.size}
								values={choices.sizes}
							/>
						) : null}
						{choices.aspectRatios.length ? (
							<Optional
								description="Instead of a size: the gateway picks this model's size for it."
								label="Aspect ratio"
								onChange={(value) => set("aspectRatio", value)}
								value={settings.aspectRatio}
								values={choices.aspectRatios}
							/>
						) : null}
						{choices.resolutions.length ? (
							<Optional
								description="Alone, a model that chooses the proportion keeps choosing it."
								label="Resolution"
								onChange={(value) => set("resolution", value)}
								value={settings.resolution}
								values={choices.resolutions}
							/>
						) : null}
						{choices.qualities.length ? (
							<Optional
								label="Quality"
								onChange={(value) => set("quality", value)}
								value={settings.quality}
								values={choices.qualities}
							/>
						) : null}
						<Optional
							label="Background"
							onChange={(value) => set("background", value)}
							value={settings.background}
							values={choices.backgrounds}
						/>
						{choices.formats.length ? (
							<Optional
								label="Output format"
								onChange={(value) => set("outputFormat", value)}
								value={settings.outputFormat}
								values={choices.formats}
							/>
						) : null}
						{choices.styles.length ? (
							<Optional
								label="Style"
								onChange={(value) => set("style", value)}
								value={settings.style}
								values={choices.styles}
							/>
						) : null}
						{choices.maxN > 1 ? (
							<NumberField.Root
								max={choices.maxN}
								min={1}
								onValueChange={(value) => set("n", value ?? undefined)}
								step={1}
								value={settings.n ?? null}
							>
								<NumberField.ScrubArea>
									<label
										className="text-sm font-medium"
										htmlFor="playground-image-n"
									>
										Images per run
									</label>
								</NumberField.ScrubArea>
								<NumberField.Group>
									<NumberField.Decrement aria-label="Fewer images" />
									<NumberField.Input
										id="playground-image-n"
										placeholder="Default"
									/>
									<NumberField.Increment aria-label="More images" />
								</NumberField.Group>
							</NumberField.Root>
						) : null}
						{choices.compression ? (
							<NumberField.Root
								max={100}
								min={0}
								onValueChange={(value) =>
									set("outputCompression", value ?? undefined)
								}
								step={1}
								value={settings.outputCompression ?? null}
							>
								<NumberField.ScrubArea>
									<label
										className="text-sm font-medium"
										htmlFor="playground-image-compression"
									>
										Compression
									</label>
								</NumberField.ScrubArea>
								<NumberField.Group>
									<NumberField.Decrement aria-label="Less compression" />
									<NumberField.Input
										id="playground-image-compression"
										placeholder="Default"
									/>
									<NumberField.Increment aria-label="More compression" />
								</NumberField.Group>
								<p className="text-xs text-fg-muted">
									JPEG and WebP only, 0-100.
								</p>
							</NumberField.Root>
						) : null}
					</div>
				</DialogBody>
				<DialogFooter>
					<DialogClose
						className={buttonStyles({ variant: "primary", size: "sm" })}
					>
						Done
					</DialogClose>
				</DialogFooter>
			</DialogContent>
		</DialogRoot>
	);
}
