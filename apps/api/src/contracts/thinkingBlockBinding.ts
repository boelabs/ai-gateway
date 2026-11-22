import { GatewayError } from "#core/errors.ts";

/**
 * Anthropic's `thinking.block_binding`: what it does with a replayed thinking block whose
 * conversation changed. Only Anthropic reads it, and thinking blocks reach no other provider, so it
 * never pins a request to Anthropic.
 */
export function thinkingBlockBinding(
	thinking: Record<string, unknown> | undefined,
	param: string,
): Record<string, unknown> | undefined {
	const binding = thinking?.block_binding;
	if (binding === undefined) {
		return undefined;
	}
	if (
		binding === null ||
		typeof binding !== "object" ||
		Array.isArray(binding)
	) {
		throw new GatewayError({
			class: "bad_request",
			code: "invalid_request_error",
			param,
			message: `${param} must be an object`,
		});
	}
	return structuredClone(binding as Record<string, unknown>);
}

/**
 * `extra_body.thinking` holding only `block_binding`, as OpenAI-shaped clients send it. It is taken
 * out of `extra_body` so it reaches Anthropic beside the thinking the gateway builds and no other
 * provider receives it. Any other `extra_body.thinking` stays where it is.
 */
export function liftThinkingBlockBinding(
	extraBody: Record<string, unknown> | undefined,
): {
	extraBody: Record<string, unknown> | undefined;
	blockBinding?: Record<string, unknown>;
} {
	const thinking = extraBody?.thinking;
	if (
		extraBody === undefined ||
		thinking === null ||
		typeof thinking !== "object" ||
		Array.isArray(thinking) ||
		Object.keys(thinking).join() !== "block_binding"
	) {
		return { extraBody };
	}
	const blockBinding = thinkingBlockBinding(
		thinking as Record<string, unknown>,
		"extra_body.thinking.block_binding",
	);
	const { thinking: _lifted, ...rest } = extraBody;
	return {
		extraBody: Object.keys(rest).length > 0 ? rest : undefined,
		...(blockBinding === undefined ? {} : { blockBinding }),
	};
}
