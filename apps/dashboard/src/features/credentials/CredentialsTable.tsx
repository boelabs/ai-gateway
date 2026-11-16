"use client";

import { type Column, DataTable, Dash } from "#/components/ui/datatable";
import { RowActions } from "#/shared/components/RowActions.tsx";
import { NewCredentialButton } from "./NewCredentialButton.tsx";
import { useConfirm } from "#/shared/feedback/confirm.tsx";
import { useRowActions } from "#/shared/lib/mutation.ts";
import { useSession } from "#/features/auth/session.tsx";
import { deleteCredentialAction } from "./actions.ts";
import { EmptyState } from "#/components/ui/page";
import { useRouter } from "next/navigation";

import {
	PencilSimpleIcon as IconPencil,
	TrashIcon as IconTrash,
	VaultIcon as IconVault,
} from "@phosphor-icons/react/dist/ssr";

import {
	DELETE_CREDENTIAL_DESCRIPTION,
	type SavedCredential,
	credentialHint,
} from "./common.ts";

export function CredentialsTable({
	credentials: loaded,
}: {
	credentials: SavedCredential[];
}) {
	const { can } = useSession();
	const router = useRouter();
	const confirm = useConfirm();
	const { rows: credentials, act } = useRowActions(
		loaded,
		(credential) => credential.id,
	);
	const writable = can("deployments:write");

	async function remove(credential: SavedCredential) {
		const confirmed = await confirm({
			title: `Delete ${credential.name}?`,
			description: DELETE_CREDENTIAL_DESCRIPTION,
			confirmLabel: "Delete credential",
		});
		if (!confirmed) {
			return;
		}
		await act(credential.id, {
			optimistic: "removed",
			action: () => deleteCredentialAction(credential.id),
			success: `${credential.name} deleted`,
			failure: "The credential could not be deleted.",
		});
	}

	const columns: Column<SavedCredential>[] = [
		{
			key: "name",
			header: "Name",
			render: (credential) => (
				<span className="font-medium">{credential.name}</span>
			),
		},
		{
			key: "adapter",
			header: "Adapter",
			render: (credential) => credential.adapterKey,
		},
		{
			key: "key",
			header: "Key",
			render: (credential) => {
				const hint = credentialHint(credential);
				return hint ? (
					<span className="font-mono text-xs text-fg-muted">{hint}</span>
				) : (
					<Dash />
				);
			},
		},
		{
			key: "updated",
			header: "Updated",
			render: (credential) => (
				<span
					className="text-xs text-fg-muted tabular-nums"
					suppressHydrationWarning
				>
					{new Date(credential.updatedAt).toLocaleDateString()}
				</span>
			),
		},
		{
			key: "actions",
			header: "",
			align: "end",
			render: (credential) =>
				writable ? (
					<RowActions
						actions={[
							{
								label: "Edit",
								icon: <IconPencil aria-hidden className="size-4" />,
								onSelect: () => router.push(`/credentials/${credential.id}`),
							},
							{
								label: "Delete",
								icon: <IconTrash aria-hidden className="size-4" />,
								danger: true,
								onSelect: () => void remove(credential),
							},
						]}
						label={`Actions for ${credential.name}`}
					/>
				) : null,
		},
	];

	if (credentials.length === 0) {
		return (
			<EmptyState
				description="Save a provider's credentials once, then pick them whenever you create a model."
				icon={IconVault}
				title="No saved credentials yet"
			>
				<NewCredentialButton />
			</EmptyState>
		);
	}

	return (
		<DataTable
			caption="Saved credentials"
			columns={columns}
			rowHref={(credential) => `/credentials/${credential.id}`}
			rowKey={(credential) => credential.id}
			rows={credentials}
		/>
	);
}
