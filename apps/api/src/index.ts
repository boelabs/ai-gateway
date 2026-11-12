import {
	systemOneDecisionsHandler,
	geminiDecisionsHandler,
	openAIDecisionsHandler,
} from "./endpoints/decisions.ts";
import { realtimeClientSecretsHandler } from "./endpoints/realtimeClientSecrets.ts";
import { type WebSocketServerLike, serve } from "@hono/node-server";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createSocketServer } from "#endpoints/socketServer.ts";
import { GatewayError } from "./core/errors.ts";
import { pingRedis } from "./cache/redis.ts";
import { Hono, type Context } from "hono";
import { pingDb } from "./db/client.ts";
import { log } from "./logging/log.ts";
import { env } from "./config/env.ts";

import {
	DEPENDENCY_RETRY_AFTER_SECONDS,
	dependencyUnavailable,
	isDependencyError,
} from "./core/dependencyError.ts";

import "./adapters/index.ts"; // registers the adapters (side-effect)

import { messagesCountTokensHandler } from "./endpoints/messagesCountTokens.ts";
import { publicizeManagementError, isManagementPath } from "./admin/errors.ts";
import { authMiddleware, requireInferenceAccess } from "./auth/middleware.ts";
import { type ErrorDialect, errorDialectFor } from "./http/errorDialect.ts";
import { installProcessErrorHandlers } from "./runtime/processErrors.ts";
import { startResponseStateGcJob } from "./db/repos/responseStates.ts";
import { startSpendLedgerGcJob } from "./ratelimit/spendLedgerGc.ts";
import { requestContextMiddleware } from "./http/requestContext.ts";
import { lifecyclePhase, isDraining } from "./runtime/lifecycle.ts";
import { authApp, dashboardConfigHandler } from "./auth/routes.ts";
import { startDashboardSessionGcJob } from "./auth/sessionGc.ts";
import { startIdempotencyGcJob } from "./http/idempotencyGc.ts";
import { installGracefulShutdown } from "./runtime/shutdown.ts";
import { embeddingsHandler } from "./endpoints/embeddings.ts";
import { chatCompletionsHandler } from "./endpoints/chat.ts";
import { transcriptionsHandler } from "./endpoints/audio.ts";
import { messagesHandler } from "./endpoints/messages.ts";
import { docsExportHandler } from "./endpoints/docs.ts";
import { getRequestId } from "./http/requestContext.ts";
import { rerankHandler } from "./endpoints/rerank.ts";
import { startTelemetry } from "./telemetry/index.ts";
import { runMigrations } from "./db/migrations.ts";
import { startVideoJobs } from "./videos/jobs.ts";
import type { AppEnv } from "./auth/types.ts";
import { adminApp } from "./admin/index.ts";

import {
	listResponseInputItemsHandler,
	responsesWebSocketHandler,
	closeResponsesWebSockets,
	retrieveResponseHandler,
	compactResponseHandler,
	deleteResponseHandler,
	responsesHandler,
} from "./endpoints/responses.ts";

import {
	videoRetrieveHandler,
	videoContentHandler,
	videoDeleteHandler,
	videoCreateHandler,
	videoListHandler,
} from "./endpoints/videos.ts";

import {
	startExtensionReloadJob,
	initializeExtensions,
	extensionStatus,
} from "./extensions/runtime.ts";

import {
	operationPersistenceStatus,
	startOperationMaintenance,
} from "./logging/operations.ts";

import {
	realtimeWebSocketHandler,
	closeRealtimeWebSockets,
} from "./endpoints/realtime.ts";

import {
	imageGenerationsHandler,
	imageEditsHandler,
} from "./endpoints/images.ts";

import {
	modelsWildcardHandler,
	listModelsHandler,
} from "./endpoints/models.ts";

installProcessErrorHandlers();
startTelemetry();

// Before anything touches a table. The extension runtime, the background jobs and readiness itself
// all query on boot, and against an un-migrated database every one of them fails — which looks like
// an application fault rather than a missing step.
if (env.MIGRATE_ON_BOOT) {
	try {
		await runMigrations();
		log.info("db", "migrations up to date");
	} catch (err) {
		// Fatal on purpose. Serving against a schema this build does not understand is worse than not
		// starting: an exit leaves the platform's rolling update on the previous version, which works.
		log.error("db", "migrations failed; refusing to start", { err });
		process.exit(1);
	}
}

try {
	await initializeExtensions();
} catch (err) {
	// Never let an extension problem brick the gateway: misconfigured artifacts/instances are already
	// disabled in-runtime (and surfaced via readiness), so the only way here is a transient failure such
	// as the database being unreachable at boot. Log and continue — the reload job retries on its
	// interval and /health/ready stays degraded until it succeeds.
	log.error(
		"extensions",
		"initial extension load failed; continuing, will retry on the reload interval",
		{ err },
	);
}

const app = new Hono<AppEnv>();
const stopOperationMaintenance = startOperationMaintenance();
const stopResponseStateGc = startResponseStateGcJob();
const stopExtensionReload = startExtensionReloadJob();
const stopVideoJobs = startVideoJobs();
const stopDashboardSessionGc = startDashboardSessionGcJob();
const stopIdempotencyGc = startIdempotencyGcJob();
const stopSpendLedgerGc = startSpendLedgerGcJob();

app.use("*", requestContextMiddleware());
app.use("*", async (c, next) => {
	const startedAt = Date.now();
	try {
		await next();
	} finally {
		log.info("http", "request completed", {
			requestId: getRequestId(c),
			operationId: c.get("operationId"),
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			durationMs: Date.now() - startedAt,
		});
	}
});

// Draining. Once SIGTERM has arrived this process is on its way out, but it keeps serving until the
// proxy notices (see runtime/shutdown.ts). `Connection: close` is how it tells a keep-alive pool not
// to send the NEXT request down a socket that is about to be closed underneath it — without it, the
// proxy happily reuses the connection and the client gets the reset instead of a clean handover.
app.use("*", async (c, next) => {
	await next();
	if (isDraining()) {
		c.header("connection", "close");
	}
});

// Global error handler: translates GatewayError to the shape of each public contract.
// /v1/messages/* -> Anthropic shape; everything else -> OpenAI shape.
/**
 * The error as the gateway understands it, or null when it is none of its business.
 *
 * A reachable-dependency failure (Postgres/Redis down) becomes a 503 + Retry-After so clients back
 * off and retry, instead of the opaque 500 a raw driver error would otherwise produce.
 */
function asGatewayError(err: unknown): GatewayError | null {
	if (GatewayError.is(err)) {
		return err;
	}
	return isDependencyError(err) ? dependencyUnavailable(err) : null;
}

/** The same error, in whichever dialect the endpoint that failed speaks. */
function errorBody(error: GatewayError, dialect: ErrorDialect) {
	switch (dialect) {
		case "anthropic":
			return error.toAnthropic();
		case "openrouter":
			return error.toOpenRouter();
		case "google":
			return error.toGoogle();
		case "typesafe":
			return error.toTypeSafe();
		default:
			return error.toOpenAI();
	}
}

app.onError((err, c) => {
	const dialect = errorDialectFor(c.req.path);
	// A reachable-dependency failure (Postgres/Redis down) becomes a 503 + Retry-After so clients back
	// off and retry, instead of the opaque 500 a raw driver error would otherwise produce.
	const raw = asGatewayError(err);
	// On /admin and /auth the caller is an operator and the detail describes their own request, so it
	// is published instead of the class's generic sentence. See admin/errors.ts.
	const gatewayError =
		raw && isManagementPath(c.req.path) ? publicizeManagementError(raw) : raw;
	if (gatewayError) {
		if (!GatewayError.is(err)) {
			log.error("http", "dependency unavailable", { err });
		}
		for (const [name, value] of Object.entries(gatewayError.headers ?? {})) {
			c.header(name, value);
		}
		const body = errorBody(gatewayError, dialect);
		return c.json(body, gatewayError.httpStatus as ContentfulStatusCode);
	}
	log.error("http", "unhandled error", { err });
	if (dialect !== "openai") {
		const internal = new GatewayError({
			class: "server",
			message: "Internal server error",
			publicMessage: "Internal server error",
			status: 500,
		});
		return c.json(errorBody(internal, dialect), 500);
	}
	return c.json(
		{
			error: {
				message: "Internal server error",
				type: "server_error",
				param: null,
				code: null,
			},
		},
		500,
	);
});

/**
 * LIVENESS. "Is this process responsive?" — answered WITHOUT touching Postgres or Redis. Wire this to
 * an orchestrator's liveness probe. It must not depend on external services: if it did, a dependency
 * blip would make the orchestrator kill every replica at once (a restart that cannot fix the
 * dependency), turning a transient outage into a self-inflicted one.
 */
app.get("/health/live", (c) =>
	c.json({
		// Deliberately "ok" while draining too: liveness answers "is this process responsive?", and a
		// container runtime that sees it fail restarts the container — cutting the drain short and
		// killing exactly the requests the drain exists to protect.
		status: "ok",
		service: "AI Gateway",
		phase: lifecyclePhase(),
		uptimeSeconds: Math.round(process.uptime()),
		time: new Date().toISOString(),
	}),
);

/**
 * READINESS. "Should this instance receive traffic right now?" — checks Postgres, Redis and the
 * extension runtime, and whether this process is shutting down. Returns 503 + Retry-After when a
 * dependency is down so the load balancer pulls the instance out (WITHOUT restarting it); it rejoins
 * automatically once dependencies recover. Wire this to the readiness probe.
 */
async function readiness(c: Context) {
	// A draining process is not a candidate for traffic, whatever its dependencies say. This answer
	// is the first thing shutdown does, and the load balancer's poll of it is what lets the instance
	// leave the rotation before it stops accepting connections.
	if (isDraining()) {
		c.header("retry-after", String(DEPENDENCY_RETRY_AFTER_SECONDS));
		c.header("connection", "close");
		return c.json(
			{
				status: "draining",
				service: "AI Gateway",
				phase: lifecyclePhase(),
				time: new Date().toISOString(),
			},
			503,
		);
	}
	const [database, cache] = await Promise.all([pingDb(), pingRedis()]);
	const extensions = extensionStatus();
	const observability = operationPersistenceStatus();
	const ok = database && cache && extensions.healthy && observability.healthy;
	if (!ok) {
		c.header("retry-after", String(DEPENDENCY_RETRY_AFTER_SECONDS));
	}
	return c.json(
		{
			status: ok ? "ok" : "degraded",
			service: "AI Gateway",
			dependencies: { database, cache },
			observability,
			extensions: {
				status: extensions.status,
				healthy: extensions.healthy,
				definitions: extensions.definitions.length,
				instances: {
					total: extensions.instances.length,
					active: extensions.instances.filter(
						(instance) => instance.status === "active",
					).length,
					disabled: extensions.instances.filter(
						(instance) => instance.status !== "active",
					).length,
				},
			},
			time: new Date().toISOString(),
		},
		ok ? 200 : 503,
	);
}

app.get("/health/ready", readiness);

// Public model discovery. Intentionally unauthenticated, like public provider model catalogs.
app.get("/v1/models", listModelsHandler);
app.get("/v1/models/*", modelsWildcardHandler);

// The documentation source for boelabs.com/docs. Unauthenticated: it is the public repository's text.
app.get("/docs/export.json", docsExportHandler);

// Dashboard capability probe. Unauthenticated and content-free: it only says whether human
// authentication exists on this deployment, which the login form reveals anyway. It lives under
// /auth rather than /dashboard because a deployment that serves a UI owns the whole /dashboard path;
// an endpoint there would be shadowed by the reverse proxy before it ever reached the gateway.
app.get("/auth/config", dashboardConfigHandler);

// Human (dashboard) authentication. Mounted only when DASH_ENABLED, and deliberately OUTSIDE
// adminApp: every /admin route requires an already-resolved operator identity, so the route that
// creates one cannot live under it.
if (env.DASH_ENABLED) {
	app.route("/auth", authApp);
}

// Admin (CRUD of models and keys) - requires an operator identity (middleware inside adminApp).
app.route("/admin", adminApp);

// Public API - requires a master or virtual key.
app.use("/v1/*", authMiddleware());
app.use("/v1/*", requireInferenceAccess());
app.post("/v1/chat/completions", chatCompletionsHandler);
app.post("/v1/responses", responsesHandler);
app.get("/v1/responses", responsesWebSocketHandler);
app.get("/v1/realtime", realtimeWebSocketHandler);
app.post("/v1/realtime/client_secrets", realtimeClientSecretsHandler);
app.post("/v1/responses/compact", compactResponseHandler);
app.get("/v1/responses/:id", retrieveResponseHandler);
app.delete("/v1/responses/:id", deleteResponseHandler);
app.get("/v1/responses/:id/input_items", listResponseInputItemsHandler);
app.post("/v1/messages", messagesHandler);
app.post("/v1/messages/count_tokens", messagesCountTokensHandler);
app.post("/v1/images/generations", imageGenerationsHandler);
app.post("/v1/images/edits", imageEditsHandler);
app.post("/v1/videos", videoCreateHandler);
app.get("/v1/videos", videoListHandler);
app.get("/v1/videos/:id/content", videoContentHandler);
app.get("/v1/videos/:id", videoRetrieveHandler);
app.delete("/v1/videos/:id", videoDeleteHandler);
app.post("/v1/audio/transcriptions", transcriptionsHandler);
app.post("/v1/embeddings", embeddingsHandler);
app.post("/v1/rerank", rerankHandler);
app.post("/v1/decisions", openAIDecisionsHandler);
app.post("/v1/systemone", systemOneDecisionsHandler);

// Gemini's API version prefix, so Google's SDKs reach the gateway by changing only the base URL.
app.use("/v1beta/*", authMiddleware());
app.use("/v1beta/*", requireInferenceAccess());
app.post("/v1beta/decisions", geminiDecisionsHandler);

const { server: webSocketServer, stop: stopSocketHeartbeat } =
	createSocketServer();
const server = serve(
	{
		fetch: app.fetch,
		port: env.PORT,
		websocket: { server: webSocketServer as WebSocketServerLike },
	},
	(info) => {
		log.info("server", "listening", { port: info.port, env: env.NODE_ENV });
	},
);

installGracefulShutdown({
	server,
	releaseConnections: async (options) => {
		closeResponsesWebSockets(options);
		await closeRealtimeWebSockets(options);
	},
	stopJobs: [
		stopOperationMaintenance,
		stopResponseStateGc,
		stopExtensionReload,
		stopVideoJobs,
		stopDashboardSessionGc,
		stopIdempotencyGc,
		stopSocketHeartbeat,
		stopSpendLedgerGc,
	],
});
