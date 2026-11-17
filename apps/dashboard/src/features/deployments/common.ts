import type { components } from "#/shared/api/schema";

/**
 * The deployment vocabulary and the pure functions over it.
 *
 * `api.ts` reads cookies through `next/headers`, so a Client Component cannot import it. The dialog
 * and the model table need these types and helpers on both sides of that boundary, so they live in a
 * module with no server import at all.
 */
export type Deployment = components["schemas"]["Deployment"];
export type CreateDeploymentInput = components["schemas"]["CreateDeployment"];
export type UpdateDeploymentInput = components["schemas"]["UpdateDeployment"];

/** Provider names by adapter key, as the gateway's adapter registry declares them. */
export type AdapterLabels = Readonly<Record<string, string>>;

/** The provider's name for an adapter key; the key itself for one the registry no longer has. */
export function adapterLabel(labels: AdapterLabels, key: string): string {
	return labels[key] ?? key;
}

/** One registered adapter: which credentials it needs, what it can execute, what it knows. */
export type AdapterSummary = components["schemas"]["AdapterSummary"];
/** A model the adapter's catalog already knows. */
export type CatalogModel = AdapterSummary["models"][number];
export type AdapterOperation = AdapterSummary["operations"][number];

/**
 * The catalog model this upstream id resolves to. Mirrors the gateway's lookup: an exact match, or a
 * dated snapshot of a known base ("gpt-5.5-2026-04-23" resolves through "gpt-5.5"). Sibling variants
 * deliberately do NOT match — "gpt-4.1-nano" is not "gpt-4.1", because one can be deprecated while
 * the other is not.
 */
export function catalogModelFor(
	models: CatalogModel[],
	upstreamModel: string,
): CatalogModel | undefined {
	const id = upstreamModel.trim();
	if (!id) {
		return undefined;
	}
	const exact = models.find((model) => model.id === id);
	if (exact) {
		return exact;
	}
	return models.find((model) => {
		if (!id.startsWith(`${model.id}-`)) {
			return false;
		}
		const suffix = id.slice(model.id.length + 1);
		return /^\d{4}-\d{2}-\d{2}$/u.test(suffix) || /^\d{2}-\d{4}$/u.test(suffix);
	});
}

/** Whether the catalog already describes this upstream id, which decides if a `catalogEntry` is required. */
export function isKnownUpstreamModel(
	models: CatalogModel[],
	upstreamModel: string,
): boolean {
	return catalogModelFor(models, upstreamModel) !== undefined;
}

/** Where a catalog model stands on its provider's retirement schedule, if it is on one. */
export type Retirement =
	| { state: "retired"; on: string }
	| { state: "retiring"; on: string };

/**
 * `retiresOn` is the first day the provider no longer serves the model, so that day already counts
 * as retired. `today` is a `YYYY-MM-DD` in UTC, the zone the dates are published in; without one
 * (a prerendered shell has no "today") there is nothing to say yet.
 */
export function retirementOf(
	model: CatalogModel | undefined,
	today: string | undefined,
): Retirement | undefined {
	const on = model?.retiresOn;
	if (!(on && today)) {
		return undefined;
	}
	return { state: on <= today ? "retired" : "retiring", on };
}

const retirementDay = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

function formatDay(day: string): string {
	return retirementDay.format(new Date(`${day}T00:00:00Z`));
}

/** "Retired Oct 23, 2026" / "Retires Jan 14, 2027": a status badge, so no sentence around it. */
export function retirementLabel(retirement: Retirement): string {
	const day = formatDay(retirement.on);
	return retirement.state === "retired" ? `Retired ${day}` : `Retires ${day}`;
}

/** The same fact as a field description, for the model already chosen. */
export function retirementNotice(retirement: Retirement): string {
	const day = formatDay(retirement.on);
	return retirement.state === "retired"
		? `The provider retired this model on ${day}.`
		: `The provider retires this model on ${day}.`;
}
