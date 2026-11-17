"use client";

import { PlusIcon as IconPlus } from "@phosphor-icons/react/dist/ssr";
import { ButtonSkeleton } from "#/shared/components/Skeleton.tsx";
import { Can } from "#/features/auth/session.tsx";
import { Button } from "#/components/ui/button";
import { Suspense } from "react";
import Link from "next/link";

export function NewCredentialButton() {
	return (
		<Suspense fallback={<ButtonSkeleton label={14} size="md" />}>
			<Can permissions={["deployments:write"]}>
				<Button nativeButton={false} render={<Link href="/credentials/new" />}>
					<IconPlus aria-hidden className="size-4" />
					New credential
				</Button>
			</Can>
		</Suspense>
	);
}
