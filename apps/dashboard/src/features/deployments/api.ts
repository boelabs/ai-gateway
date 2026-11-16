import type { components } from "#/shared/api/schema";
import { api, unwrap } from "#/shared/api/client.ts";
import { cache } from "react";

import type {
	CreateDeploymentInput,
	UpdateDeploymentInput,
	AdapterSummary,
	AdapterLabels,
} from "./common.ts";

export async function listDeployments(params?: {
	limit?: number;
	offset?: number;
	enabled?: boolean;
	publicModel?: string;
	q?: string;
}) {
	return unwrap(
		await api.GET("/admin/deployments", { params: { query: params } }),
	);
}

/** One deployment, without its credentials; `null` when no deployment has that id. */
export async function getDeployment(id: string) {
	const result = await api.GET("/admin/deployments/{id}", {
		params: { path: { id } },
	});
	if (result.response.status === 404) {
		return null;
	}
	return unwrap(result).data;
}

export async function createDeployment(
	body: CreateDeploymentInput,
	idempotencyKey?: string,
) {
	return unwrap(
		await api.POST("/admin/deployments", {
			body,
			...(idempotencyKey
				? { headers: { "Idempotency-Key": idempotencyKey } }
				: {}),
		}),
	).data;
}

export async function updateDeployment(
	id: string,
	body: UpdateDeploymentInput,
) {
	return unwrap(
		await api.PATCH("/admin/deployments/{id}", {
			params: { path: { id } },
			body,
		}),
	).data;
}

export async function saveDeployment(
	body: CreateDeploymentInput,
	existingId?: string,
	idempotencyKey?: string,
) {
	await resolveDeployment({
		publicModel: body.publicModel,
		adapterKey: body.adapterKey,
		upstreamModel: body.upstreamModel,
		...(body.catalogEntry === undefined
			? {}
			: { catalogEntry: body.catalogEntry }),
		...(body.pricing === undefined ? {} : { pricing: body.pricing }),
		...(body.transportOverrides === undefined
			? {}
			: { transportOverrides: body.transportOverrides }),
	});
	if (existingId === undefined) {
		return createDeployment(body, idempotencyKey);
	}
	const { adapterKey: _adapterKey, credentials, ...patch } = body;
	return updateDeployment(existingId, {
		...patch,
		catalogEntry: body.catalogEntry ?? null,
		pricing: body.pricing ?? null,
		transportOverrides: body.transportOverrides ?? {},
		...(credentials && Object.keys(credentials).length > 0
			? { credentials }
			: {}),
	});
}

export async function deleteDeployment(id: string): Promise<void> {
	const result = await api.DELETE("/admin/deployments/{id}", {
		params: { path: { id } },
	});
	if (result.error !== undefined) {
		unwrap(result);
	}
}

/**
 * The adapters the gateway runs, by provider name. Cached per request: a page that needs both the
 * registry and its labels reads it once.
 */
export const adapterRegistry = cache(
	async (): Promise<{ adapters: AdapterSummary[] }> => {
		const { adapters } = unwrap(await api.GET("/admin/operations")).data;
		return {
			adapters: adapters.slice().sort((a, b) => a.label.localeCompare(b.label)),
		};
	},
);

/**
 * Provider names for screens that show an adapter key. A courtesy, never a reason to fail the page:
 * when the registry cannot be read, every key is shown as it is.
 */
export const adapterLabels = cache(async (): Promise<AdapterLabels> => {
	try {
		const { adapters } = await adapterRegistry();
		return Object.fromEntries(
			adapters.map((adapter) => [adapter.id, adapter.label]),
		);
	} catch {
		return {};
	}
});

/**
 * Dry run: resolves the effective capabilities, operations and transports for a body without saving
 * it or encrypting its credentials. Worth doing before a custom catalog entry reaches the database.
 */
export async function resolveDeployment(
	body: components["schemas"]["ResolveDeployment"],
) {
	return unwrap(await api.POST("/admin/deployments/resolve", { body })).data;
}

/**
 * The distinct public model names, for the filter and picker controls on other pages.
 *
 * Deliberately swallows its failure: these are suggestions, not the page's subject. A role that
 * cannot read deployments still gets a working Logs or Keys page, with one filter fewer rather than
 * an error where the table should be.
 */
export async function publicModelNames(): Promise<string[]> {
	return listDeployments({ limit: 200 })
		.then((page) => [
			...new Set(page.data.map((deployment) => deployment.publicModel)),
		])
		.catch(() => []);
}
