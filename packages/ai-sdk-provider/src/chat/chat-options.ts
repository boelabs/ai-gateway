import { textOptionsShape } from "../responses/responses-options.ts";
import { z } from "zod/v4";

export const chatOptionsSchema = z.object({
	...textOptionsShape,
	/** Token id → bias (-100 to 100). */
	logitBias: z.record(z.string(), z.number()).optional(),
	/** Predicted output, to speed up edits of a known text. */
	prediction: z.record(z.string(), z.unknown()).optional(),
	/** How system messages are sent: `system` (default) or `developer`. */
	systemMessageMode: z.enum(["system", "developer"]).optional(),
});

export type BoelabsGatewayChatOptions = z.input<typeof chatOptionsSchema>;

/** What an assistant turn carries back on Chat Completions. */
export const chatMessageStateSchema = z.object({
	providerSpecificFields: z.record(z.string(), z.unknown()).nullish(),
});
