"use client";

import { TrashIcon as IconTrash } from "@phosphor-icons/react/dist/ssr";
import { useConfirm } from "#/shared/feedback/confirm.tsx";
import { useMutation } from "#/shared/lib/mutation.ts";
import { deleteCredentialAction } from "./actions.ts";
import { Can } from "#/features/auth/session.tsx";
import { Button } from "#/components/ui/button";
import { useRouter } from "next/navigation";

import {
	DELETE_CREDENTIAL_DESCRIPTION,
	type SavedCredential,
} from "./common.ts";

/** A credential page's header action: deleting it. Only for roles that may write deployments. */
export function CredentialHeaderActions({
	credential,
}: {
	credential: SavedCredential;
}) {
	return (
		<Can permissions={["deployments:write"]}>
			<Actions credential={credential} />
		</Can>
	);
}

function Actions({ credential }: { credential: SavedCredential }) {
	const router = useRouter();
	const confirm = useConfirm();
	const { pending, run } = useMutation();

	async function remove() {
		const confirmed = await confirm({
			title: `Delete ${credential.name}?`,
			description: DELETE_CREDENTIAL_DESCRIPTION,
			confirmLabel: "Delete credential",
		});
		if (!confirmed) {
			return;
		}
		// Leaving in the same transition: the revalidated page no longer finds the credential.
		await run(
			async () => {
				const result = await deleteCredentialAction(credential.id);
				if (result.ok) {
					router.push("/credentials");
				}
				return result;
			},
			{
				success: `${credential.name} deleted`,
				failure: "The credential could not be deleted.",
			},
		);
	}

	return (
		<Button
			disabled={pending}
			onClick={() => void remove()}
			variant="danger-outline"
		>
			<IconTrash aria-hidden className="size-4" />
			Delete
		</Button>
	);
}
