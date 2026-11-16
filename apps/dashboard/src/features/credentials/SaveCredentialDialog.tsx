"use client";

import { useIdempotencyKey } from "#/shared/lib/useIdempotencyKey.ts";
import { useMutation } from "#/shared/lib/mutation.ts";
import { createCredentialAction } from "./actions.ts";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Form } from "#/components/ui/form";

import {
	DialogDescription,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogBody,
	Dialog,
	Modal,
} from "#/components/ui/modal";

/**
 * Saves the credentials a deployment already holds under a name, so the next model can be filled
 * from them. The gateway copies them itself: nobody has to find or retype the key.
 */
export function SaveCredentialDialog({
	deploymentId,
	adapterKey,
	isOpen,
	onClose,
}: {
	deploymentId: string;
	adapterKey: string;
	isOpen: boolean;
	onClose: () => void;
}) {
	const { pending, run } = useMutation();
	const creation = useIdempotencyKey();

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const name = String(
			new FormData(event.currentTarget).get("name") ?? "",
		).trim();
		const result = await run(
			() =>
				createCredentialAction(
					{ name, fromDeploymentId: deploymentId },
					creation.key(),
				),
			{
				success: `Saved as ${name}`,
				failure: "The credentials could not be saved.",
			},
		);
		if (result.ok) {
			creation.rotate();
			onClose();
		}
	}

	return (
		<Modal
			isOpen={isOpen}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<Dialog aria-label="Save credentials" layout="sectioned">
				<DialogHeader>
					<DialogTitle>Save credentials</DialogTitle>
					<DialogDescription>
						Reuse this deployment's {adapterKey} credentials when creating other
						models.
					</DialogDescription>
				</DialogHeader>
				<Form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
					<DialogBody>
						<Input
							autoComplete="off"
							autoFocus
							label="Name"
							maxLength={120}
							name="name"
							placeholder={`${adapterKey} production`}
							required
						/>
					</DialogBody>
					<DialogFooter>
						<Button onClick={onClose} type="button" variant="secondary">
							Cancel
						</Button>
						<Button disabled={pending} type="submit">
							{pending ? "Saving…" : "Save credentials"}
						</Button>
					</DialogFooter>
				</Form>
			</Dialog>
		</Modal>
	);
}
