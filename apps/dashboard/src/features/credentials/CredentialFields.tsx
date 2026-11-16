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
			{required.map((field) => (
				<Input
					autoComplete="off"
					key={`${adapterKey}:${field}`}
					label={CREDENTIAL_LABELS[field] ?? field}
					name={`cred_${field}`}
					required={!optional}
					type={field === "baseUrl" ? "url" : "password"}
				/>
			))}
			<div className="sm:col-span-2">
				<Textarea
					className="resize-y font-mono text-xs"
					label="Extra credentials (optional)"
					name="credentialsExtra"
					placeholder='{ "baseUrl": "https://…" }'
					rows={2}
					spellCheck={false}
				/>
			</div>
		</div>
	);
}
