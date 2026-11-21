import { GatewayError } from "#core/errors.ts";
import { getCatalogEntry } from "./index.ts";

/**
 * Retirement is information, not a switch: a provider may keep serving a model past its announced
 * day, or answer the old id with its replacement, so routing never skips a retired deployment. What
 * the date changes is what the gateway says when the provider no longer knows the model, and that no
 * new deployment of it is created.
 */

/** Today as `YYYY-MM-DD` in UTC, the zone providers publish retirement days in. */
export function utcToday(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * The day a catalog model was retired, when it is on or before `today`. `retiresOn` is the first day
 * the provider no longer serves it, so that day already counts. Custom models (inline catalog
 * entries) are described by the operator and are not checked.
 */
export function catalogRetiredOn(
	adapterKey: string,
	upstreamModel: string,
	today: string = utcToday(),
): string | undefined {
	const on = getCatalogEntry(adapterKey, upstreamModel)?.retiresOn;
	return on && on <= today ? on : undefined;
}

export const MODEL_RETIRED = "model_retired";

/**
 * Rewrites the provider's "model not found" for a model past its retirement day into the reason.
 * Every other error, and a not-found for a model still in service, is returned as it is.
 */
export function explainRetiredModel(
	error: GatewayError,
	deployment: {
		adapterKey: string;
		upstreamModel: string;
		catalogEntry?: unknown;
	},
	today: string = utcToday(),
): GatewayError {
	if (error.class !== "not_found" || deployment.catalogEntry != null) {
		return error;
	}
	const on = catalogRetiredOn(
		deployment.adapterKey,
		deployment.upstreamModel,
		today,
	);
	if (!on) {
		return error;
	}
	return new GatewayError({
		class: "not_found",
		status: 404,
		code: MODEL_RETIRED,
		message: `${error.message} (${deployment.adapterKey}/${deployment.upstreamModel} was retired on ${on})`,
		publicMessage: `The provider retired the model \`${deployment.upstreamModel}\` on ${on}.`,
		failureKind: error.failureKind,
		...(error.provider ? { provider: error.provider } : {}),
		...(error.phase ? { phase: error.phase } : {}),
		cause: error,
	});
}

/** The refusal to create a deployment, or point one, at a model already retired. */
export function retiredModelRefusal(
	adapterKey: string,
	upstreamModel: string,
	today: string = utcToday(),
): GatewayError | undefined {
	const on = catalogRetiredOn(adapterKey, upstreamModel, today);
	if (!on) {
		return undefined;
	}
	const message = `The provider retired "${upstreamModel}" on ${on}; deploy its replacement instead.`;
	return new GatewayError({
		class: "bad_request",
		code: MODEL_RETIRED,
		message,
		publicMessage: message,
		param: "upstreamModel",
	});
}
