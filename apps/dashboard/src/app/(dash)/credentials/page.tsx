import { NewCredentialButton } from "#/features/credentials/NewCredentialButton.tsx";
import { CredentialsTable } from "#/features/credentials/CredentialsTable.tsx";
import { CREDENTIAL_HEADERS } from "#/features/credentials/common.ts";
import { RouteBoundary } from "#/shared/components/RouteBoundary.tsx";
import { TableSkeleton } from "#/shared/components/Skeleton.tsx";
import { listCredentials } from "#/features/credentials/api.ts";
import { adapterLabels } from "#/features/deployments/api.ts";
import { PageHeader } from "#/components/ui/page";
import { Suspense } from "react";

/**
 * Saved provider credentials. Saving one and editing one each have their own page; this one lists
 * them. They are few, so there is no search or paging.
 */
export default function CredentialsPage() {
	return (
		<>
			<PageHeader
				actions={<NewCredentialButton />}
				description="Save a provider's credentials once and pick them when creating a model. Secrets are never shown again."
				title="Credentials"
			/>
			<RouteBoundary title="Credentials could not be loaded">
				<Suspense
					fallback={<TableSkeleton headers={CREDENTIAL_HEADERS} rows={5} />}
				>
					<Credentials />
				</Suspense>
			</RouteBoundary>
		</>
	);
}

async function Credentials() {
	const [{ data }, labels] = await Promise.all([
		listCredentials({ limit: 200 }),
		adapterLabels(),
	]);
	return <CredentialsTable adapterLabels={labels} credentials={data} />;
}
