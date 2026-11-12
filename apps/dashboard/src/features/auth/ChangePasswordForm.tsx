"use client";

import { changePassword, leaveFor } from "./browser.ts";
import { ErrorNote } from "#/components/ui/page";
import { Button } from "#/components/ui/button";
import { useState, useTransition } from "react";
import { Input } from "#/components/ui/input";
import { Form } from "#/components/ui/form";

/** The gateway's minimum, repeated so a short password is caught before the round trip. */
const MIN_PASSWORD_LENGTH = 12;

export function ChangePasswordForm() {
	const [error, setError] = useState<string | null>(null);
	const [pending, startChanging] = useTransition();

	function onSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		const form = new FormData(event.currentTarget);
		const next = String(form.get("newPassword"));
		if (next !== String(form.get("confirmPassword"))) {
			setError("The new passwords do not match.");
			return;
		}
		startChanging(async () => {
			try {
				await changePassword(String(form.get("currentPassword")), next);
			} catch (cause) {
				setError(
					cause instanceof Error ? cause.message : "Password change failed.",
				);
				return;
			}
			// The new session cookies have landed; a document load leaves the old session behind.
			await leaveFor("/");
		});
	}

	return (
		<Form className="flex flex-col gap-4" onSubmit={onSubmit}>
			<Input
				autoComplete="current-password"
				autoFocus
				label="Current password"
				name="currentPassword"
				required
				type="password"
			/>
			<Input
				autoComplete="new-password"
				label="New password"
				minLength={MIN_PASSWORD_LENGTH}
				name="newPassword"
				required
				type="password"
			/>
			<Input
				autoComplete="new-password"
				label="Confirm new password"
				minLength={MIN_PASSWORD_LENGTH}
				name="confirmPassword"
				required
				type="password"
			/>
			{error ? <ErrorNote>{error}</ErrorNote> : null}
			<Button className="mt-2 w-full" disabled={pending} type="submit">
				{pending ? "Changing…" : "Change password"}
			</Button>
		</Form>
	);
}
