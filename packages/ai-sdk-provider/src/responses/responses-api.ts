import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod/v4";

/*
 * The gateway's `/v1/responses` wire (OpenResponses, compatible with OpenAI's Responses API).
 * Schemas are loose: unknown fields pass through, and unknown item or event types parse into a
 * generic shape instead of failing the call, because the gateway adds fields as providers do.
 */

const usageSchema = z
	.object({
		input_tokens: z.number().nullish(),
		input_tokens_details: z
			.object({
				cached_tokens: z.number().nullish(),
				cache_write_tokens: z.number().nullish(),
			})
			.loose()
			.nullish(),
		output_tokens: z.number().nullish(),
		output_tokens_details: z
			.object({ reasoning_tokens: z.number().nullish() })
			.loose()
			.nullish(),
		total_tokens: z.number().nullish(),
	})
	.loose();

export type ResponsesUsage = z.infer<typeof usageSchema>;

const annotationSchema = z
	.object({
		type: z.string(),
		url: z.string().nullish(),
		title: z.string().nullish(),
		start_index: z.number().nullish(),
		end_index: z.number().nullish(),
		file_id: z.string().nullish(),
		filename: z.string().nullish(),
		container_id: z.string().nullish(),
		index: z.number().nullish(),
	})
	.loose();

export type ResponsesAnnotation = z.infer<typeof annotationSchema>;

const messageItemSchema = z
	.object({
		type: z.literal("message"),
		id: z.string(),
		role: z.string().nullish(),
		phase: z.string().nullish(),
		content: z.array(
			z.union([
				z
					.object({
						type: z.literal("output_text"),
						text: z.string(),
						annotations: z.array(annotationSchema).nullish(),
						logprobs: z.array(z.unknown()).nullish(),
					})
					.loose(),
				z.object({ type: z.literal("refusal"), refusal: z.string() }).loose(),
				z.object({ type: z.string() }).loose(),
			]),
		),
	})
	.loose();

const reasoningTextSchema = z
	.object({ type: z.string(), text: z.string() })
	.loose();

const reasoningItemSchema = z
	.object({
		type: z.literal("reasoning"),
		id: z.string(),
		encrypted_content: z.string().nullish(),
		summary: z.array(reasoningTextSchema).nullish(),
		content: z.array(reasoningTextSchema).nullish(),
	})
	.loose();

const functionCallItemSchema = z
	.object({
		type: z.literal("function_call"),
		id: z.string().nullish(),
		call_id: z.string(),
		name: z.string(),
		arguments: z.string(),
	})
	.loose();

const otherItemSchema = z
	.object({ type: z.string(), id: z.string().nullish() })
	.loose();

/** Output items are read in two steps too: any `{ type }` object, then {@link classifyItem}. */
export const outputItemSchema = otherItemSchema;

export type ResponsesMessageItem = z.infer<typeof messageItemSchema>;
export type ResponsesReasoningItem = z.infer<typeof reasoningItemSchema>;
export type ResponsesFunctionCallItem = z.infer<typeof functionCallItemSchema>;

export type ClassifiedItem =
	| { kind: "message"; item: ResponsesMessageItem }
	| { kind: "reasoning"; item: ResponsesReasoningItem }
	| { kind: "function_call"; item: ResponsesFunctionCallItem }
	| { kind: "other"; item: z.infer<typeof otherItemSchema> };

const ITEM_SCHEMAS = {
	message: messageItemSchema,
	reasoning: reasoningItemSchema,
	function_call: functionCallItemSchema,
} as const;

function isKnownKind(type: string): type is keyof typeof ITEM_SCHEMAS {
	return Object.hasOwn(ITEM_SCHEMAS, type);
}

/** Narrows an output item to the shapes this provider maps; anything else is `other`. */
export function classifyItem(
	item: z.infer<typeof otherItemSchema>,
): ClassifiedItem {
	if (isKnownKind(item.type)) {
		const parsed = ITEM_SCHEMAS[item.type].safeParse(item);
		if (parsed.success) {
			return { kind: item.type, item: parsed.data } as ClassifiedItem;
		}
	}
	return { kind: "other", item };
}

const errorSchema = z
	.object({ code: z.string().nullish(), message: z.string() })
	.loose();

const responseSchemaShape = {
	id: z.string(),
	created_at: z.number().nullish(),
	model: z.string().nullish(),
	status: z.string().nullish(),
	error: errorSchema.nullish(),
	incomplete_details: z
		.object({ reason: z.string().nullish() })
		.loose()
		.nullish(),
	usage: usageSchema.nullish(),
	service_tier: z.string().nullish(),
	/** The effort the served model ran at, after the gateway snapped the request onto its ladder. */
	reasoning: z.object({ effort: z.string().nullish() }).loose().nullish(),
};

const responseZ = z
	.object({
		...responseSchemaShape,
		output: z.array(outputItemSchema),
		unified_routing: z.record(z.string(), z.unknown()).nullish(),
	})
	.loose();

export type ResponsesResponse = z.infer<typeof responseZ>;
export const responsesResponseSchema = zodSchema(responseZ);

const streamResponseSchema = z
	.object({
		...responseSchemaShape,
		output: z.array(z.unknown()).nullish(),
		unified_routing: z.record(z.string(), z.unknown()).nullish(),
	})
	.loose();

/** Stream events are read in two steps: the type here, then the event's own schema below. */
export const responsesChunkSchema = zodSchema(
	z.object({ type: z.string() }).loose(),
);

export const responseEventSchema = z
	.object({ type: z.string(), response: streamResponseSchema })
	.loose();

export const outputItemEventSchema = z
	.object({
		type: z.string(),
		output_index: z.number(),
		item: outputItemSchema,
	})
	.loose();

export const annotationAddedEventSchema = z
	.object({
		type: z.string(),
		item_id: z.string(),
		annotation: annotationSchema,
	})
	.loose();

export const deltaEventSchema = z
	.object({
		type: z.string(),
		item_id: z.string(),
		output_index: z.number().nullish(),
		summary_index: z.number().nullish(),
		content_index: z.number().nullish(),
		delta: z.string(),
		logprobs: z.array(z.unknown()).nullish(),
	})
	.loose();

export const summaryPartAddedEventSchema = z
	.object({ type: z.string(), item_id: z.string(), summary_index: z.number() })
	.loose();

export const errorEventSchema = z
	.object({ type: z.string(), code: z.string().nullish(), message: z.string() })
	.loose();
