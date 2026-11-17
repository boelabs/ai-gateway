"use client";

import { Textarea } from "#/components/ui/textarea";
import { CREDENTIAL_LABELS } from "./common.ts";
import { Input } from "#/components/ui/input";

/**
 * The inputs for an adapter's credentials: one per field it requires, then a JSON object for any
 * extra field (headers, organization…). Shared by the deployment editor and the credential pages,
 * so both ask for the same thing in the same way.
 */
export function CredentialFields({
	adapterKey,
	required,
	optional,
}: {
	adapterKey: string;
	required: readonly string[];
	/** Editing: a blank input keeps the stored value. */
	optional: boolean;
}) {
	return (
		<div className="grid gap-4 sm:grid-cols-2">
			{required.map((field, index) => (
				// Two per row; a field left alone on its row takes the whole of it.
				<div
					className={
						index === required.length - 1 && index % 2 === 0
							? "sm:col-span-2"
							: undefined
					}
					key={`${adapterKey}:${field}`}
				>
					<Input
						autoComplete="off"
						label={CREDENTIAL_LABELS[field] ?? field}
						name={`cred_${field}`}
						required={!optional}
						type={field === "baseUrl" ? "url" : "password"}
					/>
				</div>
			))}
			<div className="sm:col-span-2">
				<Textarea
					className="resize-y font-mono text-xs"
					label="Extra credentials"
					name="credentialsExtra"
					placeholder='{ "baseUrl": "https://…" }'
					rows={2}
					spellCheck={false}
				/>
			</div>
		</div>
	);
}
