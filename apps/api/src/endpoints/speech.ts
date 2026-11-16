import { assertSpeechRequestSupported } from "#gateway/speechRequestValidation.ts";
import { estimateTokenReservation } from "#router/tokenReservation.ts";
import { candidateMetadata } from "#gateway/candidateMetadata.ts";
import { speechProfileFor } from "#catalog/types.ts";
import { OperationLogDraft } from "./runtime/operationLog.ts";
import type { SpeechExecResult } from "#gateway/executor.ts";
import { route, type RouteResult } from "#router/index.ts";
import { executeSpeech } from "#gateway/executor.ts";
import type { AppEnv } from "#auth/types.ts";
import type { Usage } from "#core/usage.ts";
import type { Context } from "hono";

import {
	applyCanonicalRequestExtensions,
	PUBLIC_JSON_BODY_MAX_BYTES,
	assertFinalModelAllowed,
	notifyExtensionError,
	usageQuotaForRequest,
	computeUsageCost,
	toGatewayError,
	readJsonBody,
	parseBody,
	preflight,
} from "./runtime/pipeline.ts";

import {
	speechRequestToCanonical,
	speechRequestSchema,
} from "#contracts/openai/speech.ts";

import { SPEECH_CONTENT_TYPES } from "#core/speech.ts";

/** POST /v1/audio/speech - OpenAI-compatible contract; the audio comes back whole, never cached. */
export async function speechHandler(c: Context<AppEnv>): Promise<Response> {
	const log = new OperationLogDraft(c, "audio.speech");
	let routing: RouteResult<SpeechExecResult> | null = null;
	let finished = false;

	const finish = async (
		usage: Usage | null,
		error?: ReturnType<typeof toGatewayError> | null,
	): Promise<Usage | null> => {
		if (!routing || finished) {
			return null;
		}
		finished = true;
		return routing.finish(usage, undefined, error);
	};

	try {
		const json = await readJsonBody(c, PUBLIC_JSON_BODY_MAX_BYTES);
		log.requestBody = json;
		let canonical = speechRequestToCanonical(
			parseBody(speechRequestSchema, json),
		);
		log.publicModel = canonical.model;
		await preflight(c, canonical.model);
		canonical = await applyCanonicalRequestExtensions(
			c,
			"audio.speech",
			canonical,
		);
		log.publicModel = canonical.model;
		assertFinalModelAllowed(c, canonical.model);

		routing = await route(
			canonical.model,
			"audio.speech",
			{
				clientSignal: log.clientSignal,
				requestId: log.requestId,
				operationId: log.operationId,
				candidateEligibility: (candidate) =>
					assertSpeechRequestSupported(canonical, candidate.meta),
				tokenReservation: (candidate) =>
					estimateTokenReservation(canonical, {
						maxOutputTokens:
							speechProfileFor(candidate.meta)?.maxOutputTokens ?? 0,
					}),
				usageQuota: usageQuotaForRequest(c),
			},
			(candidate, ctx) => executeSpeech(candidate.adapter, canonical, ctx),
		);
		log.applyRouting(routing);
		log.upstreamTtftMs = Date.now() - routing.upstreamStartedAt;

		const { response } = routing.value;
		const usage = response.usage ?? null;
		const settledUsage = (await finish(usage)) ?? usage;
		log.write({
			status: "success",
			httpStatus: 200,
			usage: settledUsage,
			cost: computeUsageCost(routing.candidate.meta, settledUsage),
			firstOutputMs: null,
			responseBody: {
				format: response.format,
				bytes: response.audio.byteLength,
			},
			metadata: {
				...candidateMetadata(routing.candidate),
				terminal: routing.value.terminal,
			},
			error: null,
		});
		return new Response(response.audio, {
			status: 200,
			headers: { "content-type": SPEECH_CONTENT_TYPES[response.format] },
		});
	} catch (error) {
		const ge = toGatewayError(error);
		log.applyFailedAttempts(ge.attempts);
		await finish(null, ge);
		await notifyExtensionError(c, "audio.speech", log.publicModel, ge);
		log.writeError(ge);
		throw ge;
	}
}
