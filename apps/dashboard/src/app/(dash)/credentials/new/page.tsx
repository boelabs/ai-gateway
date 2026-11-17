import { RouteBoundary } from "#/shared/components/RouteBoundary.tsx";
import { adapterRegistry } from "#/features/deployments/api.ts";
import { Breadcrumbs } from "#/shared/components/Breadcrumbs";
import { PageHeader } from "#/components/ui/page";
import { Suspense } from "react";

import {
	CredentialFormSkeleton,
	CredentialForm,
} from "#/features/credentials/CredentialForm.tsx";

export default function NewCredentialPage() {
	return (
		<>
			<Breadcrumbs
				items={[
					{ label: "Credentials", href: "/credentials" },
					{ label: "New" },
				]}
			/>
			<PageHeader
				description="Save a provider's credentials to reuse them across models."
				title="New credential"
			/>
			<RouteBoundary title="The adapters could not be loaded">
				<Suspense fallback={<CredentialFormSkeleton />}>
					<Editor />
				</Suspense>
			</RouteBoundary>
		</>
	);
}

async function Editor() {
	const { adapters } = await adapterRegistry();
	return <CredentialForm adapters={adapters} />;
}
