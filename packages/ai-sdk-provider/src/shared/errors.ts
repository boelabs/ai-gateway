import { z } from "zod/v4";

import {
	createJsonErrorResponseHandler,
	lazySchema,
	zodSchema,
} from "@ai-sdk/provider-utils";

/**
 * Every gateway error body. OpenAI-shaped endpoints send `type`/`param` and a string `code`;
 * `/v1/rerank` follows OpenRouter and sends a numeric `code`.
 */
const gatewayErrorSchema = lazySchema(() =>
	zodSchema(
		z.object({
			error: z.object({
				message: z.string(),
				type: z.string().nullish(),
				param: z.unknown().nullish(),
				code: z.union([z.string(), z.number()]).nullish(),
			}),
		}),
	),
);

export const failedResponseHandler = createJsonErrorResponseHandler({
	errorSchema: gatewayErrorSchema,
	errorToMessage: (data) => data.error.message,
});
