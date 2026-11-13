"use client";

import { useIdempotencyKey } from "#/shared/lib/useIdempotencyKey.ts";
import { ModelListInput } from "#/shared/components/ModelPicker.tsx";
import { FormActions } from "#/shared/components/FormActions.tsx";
import { FormSkeleton } from "#/shared/components/Skeleton.tsx";
import { createKeyAction, updateKeyAction } from "./actions.ts";
import { LimitField } from "#/shared/components/LimitField.tsx";
import { Suspense, use, useState, useTransition } from "react";
import { Select, SelectItem } from "#/components/ui/select";
import { useConfirm } from "#/shared/feedback/confirm.tsx";
import { PrivateKeySwitch } from "./PrivateKeySwitch.tsx";
import { useSession } from "#/features/auth/session.tsx";
import { IssuedKeyDialog } from "./IssuedKeyDialog.tsx";
import { useMutation } from "#/shared/lib/mutation.ts";
import { Panel } from "#/shared/components/Panel.tsx";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Form } from "#/components/ui/form";
import { useRouter } from "next/navigation";

import {
	type CreatedVirtualKey,
	type SecretState,
	type VirtualKey,
	secretState,
	formatCents,
} from "./common.ts";

import {
	type KeyDraft,
	toCreateBody,
	toUpdateBody,
	draftFromKey,
	EMPTY_DRAFT,
} from "./draft.ts";

const LIST = "/keys";
const RESET_PERIODS = ["hourly", "daily", "weekly", "monthly"] as const;
const NO_RESET = "never";
const RESET_LABELS: Record<(typeof RESET_PERIODS)[number], string> = {
	hourly: "Every hour",
	daily: "Every day",
	weekly: "Every week",
	monthly: "Every month",
};

/** What an existing key's panel says about its secret. */
const SECRET_STATE: Record<SecretState, string> = {
	copyable: "The secret is stored encrypted: Copy key copies it again.",
	private:
		"Private: the secret was shown once and is not stored. Regenerate the key to get a new one.",
	sealed:
		"The secret is stored, but copying keys is turned off on this gateway.",
};

/**
 * One form for issuing a key and for editing one, on its own page.
 *
 * They were never two different questions — a budget, a rate limit and a scope are the same
 * decisions on day one and on day ninety — and splitting them is how a dashboard ends up able to
 * create a key it cannot afterwards correct.
 *
 * Turning the key on or off and deleting it are the page header's actions, not fields here, so the
 * form never sends `enabled`: a save cannot undo a toggle made after the page loaded.
 */
export function KeyForm({
	existing,
	models,
}: {
	existing?: VirtualKey;
	/** Suggestions for the allowed models; unwrapped by that one field so the form never waits on it. */
	models: Promise<string[]>;
}) {
	const router = useRouter();
	const confirm = useConfirm();
	const { can } = useSession();
	const save = useMutation();
	const reset = useMutation();
	const seal = useMutation();
	const issueKey = useIdempotencyKey();
	/** Captured once: a refresh after a header action must not wipe unsaved edits. */
	const [draft, setDraft] = useState<KeyDraft>(() =>
		existing ? draftFromKey(existing) : EMPTY_DRAFT,
	);
	const [error, setError] = useState<string | null>(null);
	const [issued, setIssued] = useState<CreatedVirtualKey | null>(null);
	/** Leaving for the list is a transition: the button stays busy until that page is on screen. */
	const [navigating, startNavigating] = useTransition();
	const writable = can("keys:write");

	function leave() {
		startNavigating(() => {
			router.push(LIST);
			router.refresh();
		});
	}

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		if (draft.name.trim() === "") {
			setError("The key needs a name.");
			return;
		}
		if (existing) {
			const body = toUpdateBody(
				{ ...draft, enabled: existing.enabled },
				existing,
			);
			if (Object.keys(body).length === 0) {
				leave();
				return;
			}
			const result = await save.run(() => updateKeyAction(existing.id, body), {
				success: `${draft.name.trim()} updated`,
				failure: "The key could not be updated.",
			});
			if (!result.ok) {
				setError(result.message);
				return;
			}
			leave();
			return;
		}
		const result = await save.run(
			() => createKeyAction(toCreateBody(draft), issueKey.key()),
			{
				success: `${draft.name.trim()} created`,
				failure: "The key could not be created.",
			},
		);
		if (!result.ok) {
			setError(result.message);
			return;
		}
		issueKey.rotate();
		setIssued(result.data);
	}

	async function resetSpend(key: VirtualKey) {
		const confirmed = await confirm({
			title: `Reset the spend on ${key.name}?`,
			description:
				"The budget counter starts over at zero. Past usage stays in the logs; only the counter moves.",
			confirmLabel: "Reset spend",
			tone: "primary",
		});
		if (!confirmed) {
			return;
		}
		await reset.run(() => updateKeyAction(key.id, { resetSpend: true }), {
			success: `Spend reset on ${key.name}`,
			failure: "The spend could not be reset.",
		});
	}

	async function makePrivate(key: VirtualKey) {
		const confirmed = await confirm({
			title: `Make ${key.name} private?`,
			description:
				"The stored secret is erased, so it can never be copied again. The key keeps working; only regenerating it can make it copyable again.",
			confirmLabel: "Make private",
		});
		if (!confirmed) {
			return;
		}
		await seal.run(() => updateKeyAction(key.id, { private: true }), {
			success: `${key.name} is now private`,
			failure: "The key could not be made private.",
		});
	}

	return (
		<>
			<KeyFields
				disabled={!writable || issued !== null}
				draft={draft}
				editing={existing !== undefined}
				error={error}
				onChange={setDraft}
				onSubmit={submit}
				pending={save.pending || navigating}
				{...(existing
					? {
							spent: formatCents(existing.spendCents),
							secret: secretState(existing),
						}
					: {})}
				{...(existing && writable && !existing.private
					? {
							keyAction: (
								<Button
									disabled={seal.pending}
									onClick={() => void makePrivate(existing)}
									size="sm"
									type="button"
									variant="secondary"
								>
									Make private
								</Button>
							),
						}
					: {})}
				{...(existing && writable
					? {
							resetAction: (
								<Button
									disabled={reset.pending}
									onClick={() => void resetSpend(existing)}
									size="sm"
									type="button"
									variant="secondary"
								>
									Reset spend
								</Button>
							),
						}
					: {})}
			>
				<Suspense
					fallback={
						<AllowedModels
							models={[]}
							onChange={(value) =>
								setDraft((current) => ({ ...current, allowedModels: value }))
							}
							value={draft.allowedModels}
						/>
					}
				>
					<SuggestedModels
						models={models}
						onChange={(value) =>
							setDraft((current) => ({ ...current, allowedModels: value }))
						}
						value={draft.allowedModels}
					/>
				</Suspense>
			</KeyFields>
			<IssuedKeyDialog
				issued={issued}
				onClose={() => {
					setIssued(null);
					leave();
				}}
			/>
		</>
	);
}

/** The form's panels, without the session or the gateway: the skeleton renders the same thing. */
function KeyFields({
	draft,
	editing,
	spent,
	secret,
	error,
	pending,
	disabled,
	keyAction,
	resetAction,
	onChange,
	onSubmit,
	children,
}: {
	draft: KeyDraft;
	editing: boolean;
	/** What the key has spent in the current period, when editing. */
	spent?: string;
	/** What can be done with the secret, when editing. */
	secret?: SecretState;
	error: string | null;
	pending: boolean;
	disabled: boolean;
	keyAction?: React.ReactNode;
	resetAction?: React.ReactNode;
	onChange: (update: (current: KeyDraft) => KeyDraft) => void;
	onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
	/** The allowed-models field, which may wait on its suggestions. */
	children: React.ReactNode;
}) {
	function set<K extends keyof KeyDraft>(field: K, value: KeyDraft[K]) {
		onChange((current) => ({ ...current, [field]: value }));
	}

	return (
		<Form className="flex flex-col gap-3" onSubmit={onSubmit}>
			<fieldset className="contents" disabled={disabled}>
				<Panel
					action={keyAction}
					description={
						secret === undefined
							? "The secret is shown right after the key is created."
							: SECRET_STATE[secret]
					}
					title="Key"
				>
					<div className="flex flex-col gap-4">
						<Input
							autoFocus={!editing}
							label="Name"
							onValueChange={(value) => set("name", value)}
							placeholder="e.g. production-backend"
							required
							value={draft.name}
						/>
						{editing ? null : (
							<PrivateKeySwitch
								checked={draft.private}
								onCheckedChange={(checked) => set("private", checked)}
							/>
						)}
					</div>
				</Panel>

				<Panel
					description="The public models a client holding this key may call."
					title="Access"
				>
					{children}
				</Panel>

				<Panel
					action={resetAction}
					description={
						spent === undefined
							? "Zero means no limit."
							: `Spent ${spent} in the current period. Zero means no limit.`
					}
					title="Limits"
				>
					<div className="flex flex-col gap-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<LimitField
								decimals={2}
								label="Budget (USD)"
								onValueChange={(value) =>
									set("budget", value === 0 ? "" : String(value))
								}
								value={Number(draft.budget || 0)}
							/>
							<Select
								label="Budget resets"
								onValueChange={(value) =>
									set(
										"budgetReset",
										value === NO_RESET
											? ""
											: (value as (typeof RESET_PERIODS)[number]),
									)
								}
								value={draft.budgetReset === "" ? NO_RESET : draft.budgetReset}
							>
								<SelectItem value={NO_RESET}>Never (lifetime total)</SelectItem>
								{RESET_PERIODS.map((period) => (
									<SelectItem key={period} value={period}>
										{RESET_LABELS[period]}
									</SelectItem>
								))}
							</Select>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<LimitField
								label="Requests per minute"
								onValueChange={(value) =>
									set("rpm", value === 0 ? "" : String(value))
								}
								value={Number(draft.rpm || 0)}
							/>
							<LimitField
								label="Tokens per minute"
								onValueChange={(value) =>
									set("tpm", value === 0 ? "" : String(value))
								}
								step={1000}
								value={Number(draft.tpm || 0)}
							/>
						</div>
					</div>
				</Panel>

				<Panel
					description="Leave it empty and the key never expires. Times are in your timezone."
					title="Expiry"
				>
					<Input
						label="Expires (optional)"
						onValueChange={(value) => set("expiresAt", value)}
						type="datetime-local"
						value={draft.expiresAt}
					/>
				</Panel>
			</fieldset>

			<FormActions
				cancelHref={LIST}
				disabled={disabled}
				error={error}
				pending={pending}
				submitLabel={editing ? "Save changes" : "Create key"}
			/>
		</Form>
	);
}

function AllowedModels({
	models,
	value,
	onChange,
}: {
	models: readonly string[];
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return (
		<ModelListInput
			description="Empty allows every public model."
			emptyHint="Press Enter to allow this model name."
			label="Allowed public models"
			models={models}
			onChange={onChange}
			value={value}
		/>
	);
}

/** Unwraps the suggestions where suspending costs one field's list rather than the form. */
function SuggestedModels({
	models,
	...props
}: {
	models: Promise<string[]>;
	value: string[];
	onChange: (value: string[]) => void;
}) {
	return <AllowedModels models={use(models)} {...props} />;
}

/** The form itself, inert: same panels, same heights, nothing moves when it arrives. */
export function KeyFormSkeleton({ editing = false }: { editing?: boolean }) {
	return (
		<FormSkeleton>
			<KeyFields
				disabled
				draft={EMPTY_DRAFT}
				editing={editing}
				error={null}
				onChange={noop}
				onSubmit={noop}
				pending={false}
				{...(editing
					? {
							spent: formatCents(0),
							secret: "copyable" as const,
							keyAction: (
								<Button size="sm" type="button" variant="secondary">
									Make private
								</Button>
							),
							resetAction: (
								<Button size="sm" type="button" variant="secondary">
									Reset spend
								</Button>
							),
						}
					: {})}
			>
				<AllowedModels models={[]} onChange={noop} value={[]} />
			</KeyFields>
		</FormSkeleton>
	);
}

function noop() {
	// The skeleton's controls are inert.
}
