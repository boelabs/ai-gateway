"use client";

import { createCredentialAction, updateCredentialAction } from "./actions.ts";
import { readCredentialFields, type SavedCredential } from "./common.ts";
import type { AdapterSummary } from "#/features/deployments/common.ts";
import { useIdempotencyKey } from "#/shared/lib/useIdempotencyKey.ts";
import { useNotify } from "#/shared/feedback/notifications.tsx";
import { FormSkeleton } from "#/shared/components/Skeleton.tsx";
import { FormActions } from "#/shared/components/FormActions";
import { SearchableSelect } from "#/components/ui/select";
import { CredentialFields } from "./CredentialFields.tsx";
import { useRef, useState, useTransition } from "react";
import { Panel } from "#/shared/components/Panel.tsx";
import { Input } from "#/components/ui/input";
import { useRouter } from "next/navigation";
import { Form } from "#/components/ui/form";

const LIST = "/credentials";

/**
 * Saving a credential and editing one, on its own page. The secret is write-only: editing shows
 * empty inputs, and a blank one keeps what is stored.
 */
export function CredentialForm({
	adapters,
	existing,
}: {
	adapters: AdapterSummary[];
	/** Present when editing; a credential's adapter cannot change. */
	existing?: SavedCredential;
}) {
	const router = useRouter();
	const notify = useNotify();
	const editing = existing !== undefined;
	const [adapterKey, setAdapterKey] = useState(existing?.adapterKey ?? "");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [navigating, startNavigating] = useTransition();
	const submitting = useRef(false);
	const creation = useIdempotencyKey();
	const required =
		adapters.find((entry) => entry.id === adapterKey)?.credentials.required ??
		[];

	async function save(form: FormData) {
		const name = String(form.get("name") ?? "").trim();
		const credentials = readCredentialFields(form, required);
		if (!existing) {
			if (!adapterKey) {
				throw new Error("Choose an adapter.");
			}
			return createCredentialAction(
				{ name, adapterKey, credentials },
				creation.key(),
			);
		}
		return updateCredentialAction(existing.id, {
			...(name === existing.name ? {} : { name }),
			...(Object.keys(credentials).length > 0 ? { credentials } : {}),
		});
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
			const form = new FormData(event.currentTarget);
			const name = String(form.get("name") ?? "").trim();
			if (
				editing &&
				name === existing.name &&
				Object.keys(readCredentialFields(form, required)).length === 0
			) {
				startNavigating(() => router.push(LIST));
				return;
			}
			const result = await save(form);
			if (!result.ok) {
				setError(result.message);
				return;
			}
			creation.rotate();
			notify.success(`${result.data.name} saved`);
			startNavigating(() => {
				router.push(LIST);
				router.refresh();
			});
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "The credential could not be saved.",
			);
		} finally {
			submitting.current = false;
			setPending(false);
		}
	}

	return (
		<Form className="flex flex-col gap-3" onSubmit={onSubmit}>
			<Panel
				description="The name you pick it by when creating a model."
				title="Credential"
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<Input
						autoComplete="off"
						defaultValue={existing?.name ?? ""}
						label="Name"
						maxLength={120}
						name="name"
						placeholder="Anthropic production"
						required
					/>
					<SearchableSelect
						disabled={editing}
						items={adapters.map((entry) => ({
							value: entry.id,
							label: entry.id,
						}))}
						label="Adapter"
						name="adapterKey"
						onValueChange={(key) => {
							if (key) {
								setAdapterKey(key);
							}
						}}
						placeholder="Choose an adapter"
						required
						searchPlaceholder="Search adapters"
						value={adapterKey || null}
					/>
				</div>
			</Panel>

			{adapterKey ? (
				<Panel
					description={
						editing
							? "Leave a field blank to keep the stored value."
							: "What the adapter needs to reach the provider."
					}
					title="Credentials"
				>
					<CredentialFields
						adapterKey={adapterKey}
						optional={editing}
						required={required}
					/>
				</Panel>
			) : null}

			<FormActions
				cancelHref={LIST}
				error={error}
				pending={pending || navigating}
				submitLabel={editing ? "Save changes" : "Save credential"}
			/>
		</Form>
	);
}

/** The form itself, inert and with its text masked: same panels, same heights, nothing moves. */
export function CredentialFormSkeleton() {
	return (
		<FormSkeleton>
			<CredentialForm adapters={[]} />
		</FormSkeleton>
	);
}
