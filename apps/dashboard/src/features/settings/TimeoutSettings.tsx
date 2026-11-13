"use client";

import { FormSkeleton } from "#/shared/components/Skeleton";
import { useSession } from "#/features/auth/session.tsx";
import { saveRouterSettingsAction } from "./actions.ts";
import type { RouterSettings } from "./common.ts";

import {
	SettingsCardSkeleton,
	type SettingsCopy,
	SettingsCard,
} from "./SettingsCard.tsx";

import {
	ExecutionPoliciesEditor,
	readExecutionPolicies,
} from "./ExecutionPolicies.tsx";

const DEADLINES: SettingsCopy = {
	title: "Deadlines",
	description:
		"In seconds. Response: until the answer starts. Idle: longest silence in a stream, 0 for none. Total: the whole request, retries included.",
	note: "",
};

/** How long the gateway waits on an upstream, per call type and mode, saved as one policy. */
export function TimeoutSettings({
	settings,
}: {
	settings: RouterSettings | null;
}) {
	const { can } = useSession();
	const editable = can("settings:write");
	return (
		<SettingsCard
			copy={DEADLINES}
			editable={editable}
			onSave={(form) =>
				saveRouterSettingsAction({
					executionPolicies: readExecutionPolicies(form),
				})
			}
			success="Deadlines saved"
		>
			<ExecutionPoliciesEditor
				editable={editable}
				policies={settings?.executionPolicies}
			/>
		</SettingsCard>
	);
}

export function TimeoutSettingsSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading timeouts" role="status">
			<SettingsCardSkeleton copy={DEADLINES}>
				<FormSkeleton>
					<ExecutionPoliciesEditor editable policies={undefined} />
				</FormSkeleton>
			</SettingsCardSkeleton>
		</div>
	);
}
