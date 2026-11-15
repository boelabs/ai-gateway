import type { ResolvedModelMetadata } from "#catalog/types.ts";
import { GatewayError } from "#core/errors.ts";

/**
 * Service modes a client selects with a suffix on the model slug, OpenRouter style:
 * `gpt-6.1-sol:flex`, `claude-opus-5-5:fast`, `gemini-3.8-flash:priority`.
 *
 * A mode is the same model served differently (faster, cheaper, or with reserved capacity), never a
 * different model. A model supports a mode when its catalog prices that tier (`pricing.serviceTiers`)
 * and its adapter knows how to request it: a mode the gateway cannot bill or cannot send is refused
 * rather than silently served at the standard tier.
 */
export const SERVICE_MODES = ["fast", "flex", "priority"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

const MODE_SET: ReadonlySet<string> = new Set(SERVICE_MODES);

export function isServiceMode(value: string): value is ServiceMode {
	return MODE_SET.has(value);
}

/**
 * Splits `model:mode` into the public model and the mode. Only a known mode is split off, so a public
 * model whose own name contains a colon keeps working.
 */
export function parseServiceMode(model: string): {
	publicModel: string;
	serviceMode?: ServiceMode;
} {
	const index = model.lastIndexOf(":");
	if (index <= 0) {
		return { publicModel: model };
	}
	const suffix = model.slice(index + 1);
	return isServiceMode(suffix)
		? { publicModel: model.slice(0, index), serviceMode: suffix }
		: { publicModel: model };
}

/** Whether a deployment can serve a mode: priced in its catalog and sendable by its adapter. */
export function supportsServiceMode(
	meta: Pick<ResolvedModelMetadata, "pricing">,
	adapterModes: ReadonlySet<ServiceMode> | undefined,
	mode: ServiceMode,
): boolean {
	return (
		adapterModes?.has(mode) === true &&
		meta.pricing?.serviceTiers?.[mode] !== undefined
	);
}

export function unsupportedServiceMode(
	publicModel: string,
	mode: ServiceMode,
): GatewayError {
	const message = `The model \`${publicModel}\` does not support the \`${mode}\` service mode.`;
	return new GatewayError({
		class: "bad_request",
		code: "unsupported_service_mode",
		message,
		publicMessage: message,
		param: "model",
	});
}

/**
 * A request may not ask for two different tiers: the slug's mode and an explicit `service_tier` must
 * agree. Absent, `auto` and `default` leave the choice to the slug.
 */
export function assertServiceTierAgrees(
	mode: ServiceMode | undefined,
	serviceTier: string | undefined,
	equivalents: Partial<Record<ServiceMode, readonly string[]>> = {},
): void {
	if (
		mode === undefined ||
		serviceTier === undefined ||
		serviceTier === "auto" ||
		serviceTier === "default"
	) {
		return;
	}
	const accepted = equivalents[mode] ?? [mode];
	if (!accepted.includes(serviceTier)) {
		const message = `service_tier \`${serviceTier}\` conflicts with the \`:${mode}\` model suffix.`;
		throw new GatewayError({
			class: "bad_request",
			code: "conflicting_service_tier",
			message,
			publicMessage: message,
			param: "service_tier",
		});
	}
}
