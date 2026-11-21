import { zodSchema } from "@ai-sdk/provider-utils";
import { z } from "zod/v4";

/* The gateway's `/v1/chat/completions` wire. Loose, like the Responses schemas. */

const usageZ = z
	.object({
		prompt_tokens: z.number().nullish(),
		completion_tokens: z.number().nullish(),
		total_tokens: z.number().nullish(),
		prompt_tokens_details: z
			.object({
				cached_tokens: z.number().nullish(),
				cache_write_tokens: z.number().nullish(),
			})
			.loose()
			.nullish(),
		completion_tokens_details: z
			.object({ reasoning_tokens: z.number().nullish() })
			.loose()
			.nullish(),
	})
	.loose();

export type ChatUsage = z.infer<typeof usageZ>;

const annotationZ = z
	.object({
		type: z.string(),
		url_citation: z
			.object({
				url: z.string(),
				title: z.string().nullish(),
				start_index: z.number().nullish(),
				end_index: z.number().nullish(),
			})
			.loose()
			.nullish(),
	})
	.loose();

export type ChatAnnotation = z.infer<typeof annotationZ>;

const fieldsZ = z.record(z.string(), z.unknown());

const toolCallZ = z
	.object({
		id: z.string().nullish(),
		type: z.string().nullish(),
		function: z.object({ name: z.string(), arguments: z.string() }).loose(),
	})
	.loose();

const responseZ = z
	.object({
		id: z.string().nullish(),
		created: z.number().nullish(),
		model: z.string().nullish(),
		choices: z.array(
			z
				.object({
					finish_reason: z.string().nullish(),
					logprobs: z.unknown().nullish(),
					message: z
						.object({
							content: z.string().nullish(),
							refusal: z.string().nullish(),
							reasoning: z.string().nullish(),
							reasoning_content: z.string().nullish(),
							tool_calls: z.array(toolCallZ).nullish(),
							annotations: z.array(annotationZ).nullish(),
							provider_specific_fields: fieldsZ.nullish(),
						})
						.loose(),
				})
				.loose(),
		),
		usage: usageZ.nullish(),
		service_tier: z.string().nullish(),
		system_fingerprint: z.string().nullish(),
		unified_routing: fieldsZ.nullish(),
	})
	.loose();

export type ChatResponse = z.infer<typeof responseZ>;
export const chatResponseSchema = zodSchema(responseZ);

const chunkZ = z
	.object({
		id: z.string().nullish(),
		created: z.number().nullish(),
		model: z.string().nullish(),
		choices: z
			.array(
				z
					.object({
						finish_reason: z.string().nullish(),
						logprobs: z.unknown().nullish(),
						delta: z
							.object({
								content: z.string().nullish(),
								refusal: z.string().nullish(),
								reasoning: z.string().nullish(),
								reasoning_content: z.string().nullish(),
								tool_calls: z
									.array(
										z
											.object({
												index: z.number().nullish(),
												id: z.string().nullish(),
												type: z.string().nullish(),
												function: z
													.object({
														name: z.string().nullish(),
														arguments: z.string().nullish(),
													})
													.loose()
													.nullish(),
											})
											.loose(),
									)
									.nullish(),
								annotations: z.array(annotationZ).nullish(),
								provider_specific_fields: fieldsZ.nullish(),
							})
							.loose()
							.nullish(),
					})
					.loose(),
			)
			.nullish(),
		usage: usageZ.nullish(),
		service_tier: z.string().nullish(),
		unified_routing: fieldsZ.nullish(),
		error: z
			.object({ message: z.string(), code: z.unknown().nullish() })
			.loose()
			.nullish(),
	})
	.loose();

export type ChatChunk = z.infer<typeof chunkZ>;
export const chatChunkSchema = zodSchema(chunkZ);
