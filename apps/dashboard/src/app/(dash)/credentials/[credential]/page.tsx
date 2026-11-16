import { CredentialHeaderActions } from "#/features/credentials/CredentialHeaderActions.tsx";
import { RouteBoundary } from "#/shared/components/RouteBoundary.tsx";
import { credentialHint } from "#/features/credentials/common.ts";
import { ButtonSkeleton } from "#/shared/components/Skeleton.tsx";
import { adapterRegistry } from "#/features/deployments/api.ts";
import { TextSkeleton } from "#/shared/components/TextSkeleton";
import { getCredential } from "#/features/credentials/api.ts";
import { Breadcrumbs } from "#/shared/components/Breadcrumbs";
import { PageHeader } from "#/components/ui/page";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
	CredentialFormSkeleton,
	CredentialForm,
} from "#/features/credentials/CredentialForm.tsx";

type Params = PageProps<"/credentials/[credential]">["params"];

/** Credentials are identified by a UUID; anything else is not one, and is not looked for. */
const CREDENTIAL_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** One saved credential: its name and hint up top, the form that saved it below. */
export default function CredentialPage(
	props: PageProps<"/credentials/[credential]">,
) {
	return (
		<RouteBoundary title="The credential could not be loaded">
			<Suspense fallback={<CredentialPageSkeleton />}>
				<Credential params={props.params} />
			</Suspense>
		</RouteBoundary>
	);
}

async function Credential({ params }: { params: Params }) {
	const { credential: id } = await params;
	const [credential, registry] = await Promise.all([
		CREDENTIAL_ID.test(id) ? getCredential(id) : null,
		adapterRegistry(),
	]);
	if (!credential) {
		notFound();
	}
	const hint = credentialHint(credential);
	return (
		<>
			<Breadcrumbs
				items={[
					{ label: "Credentials", href: "/credentials" },
					{ label: credential.name },
				]}
				recent={credential.name}
			/>
			<PageHeader
				actions={<CredentialHeaderActions credential={credential} />}
				description={
					hint ? (
						<>
							{credential.adapterKey} ·{" "}
							<span className="font-mono">{hint}</span>
						</>
					) : (
						credential.adapterKey
					)
				}
				title={credential.name}
			/>
			<CredentialForm
				adapters={registry.adapters}
				existing={credential}
				key={`${credential.id}:${credential.updatedAt}`}
			/>
		</>
	);
}

function CredentialPageSkeleton() {
	return (
		<>
			<Breadcrumbs
				items={[{ label: "Credentials", href: "/credentials" }, { label: "…" }]}
			/>
			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex min-w-0 flex-col gap-1">
					<h1 className="text-xl font-semibold">
						<TextSkeleton length={18} />
					</h1>
					<p className="text-sm">
						<TextSkeleton length={24} />
					</p>
				</div>
				<ButtonSkeleton label={6} size="md" />
			</header>
			<CredentialFormSkeleton />
		</>
	);
}
