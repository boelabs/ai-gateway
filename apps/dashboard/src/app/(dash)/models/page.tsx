import { listDeployments, adapterLabels } from "#/features/deployments/api.ts";
import { ModelsSkeleton } from "#/features/deployments/ModelsSkeleton.tsx";
import { RouteBoundary } from "#/shared/components/RouteBoundary.tsx";
import { PageHeader } from "#/components/ui/page";
import { Suspense } from "react";

import {
	NewDeploymentButton,
	ModelsView,
} from "#/features/deployments/ModelsView.tsx";

/**
 * Public models and the deployments behind them, in one flat table sorted by public model. Each
 * deployment is created and edited on its own page (`/models/new`, `/models/[deployment]`).
 */
export default function ModelsPage() {
	return (
		<>
			<PageHeader
				actions={<NewDeploymentButton />}
				description="Manage the deployments behind your public models."
				title="Models"
			/>
			<RouteBoundary title="Models could not be loaded">
				<Suspense fallback={<ModelsSkeleton />}>
					<Deployments />
				</Suspense>
			</RouteBoundary>
		</>
	);
}

async function Deployments() {
	const [page, labels] = await Promise.all([
		listDeployments({ limit: 200 }),
		adapterLabels(),
	]);
	return <ModelsView adapterLabels={labels} deployments={page.data} />;
}
