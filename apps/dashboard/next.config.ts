import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The browser talks only to this origin (the gateway is reached through the dashboard's own relay),
 * so everything is `'self'`. Scripts keep `'unsafe-inline'`: the theme script and Next's inline
 * RSC payloads have no nonce, because a nonce needs every page rendered per request and the
 * dashboard's Partial Prefetching serves static shells (Next's CSP guide: nonces are incompatible
 * with it), and adding a hash would make browsers ignore `'unsafe-inline'` and block Next's own
 * scripts. Scripts from any other origin, plugins, framing and form posts elsewhere stay blocked.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data:",
	"media-src 'self' blob: data:",
	"font-src 'self'",
	"connect-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

const SECURITY_HEADERS = [
	{ key: "Content-Security-Policy", value: CONTENT_SECURITY_POLICY },
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	{ key: "X-Frame-Options", value: "DENY" },
];

/**
 * The dashboard is its own product: its own image, its own domain, its own process.
 *
 * Nothing about the gateway appears in this file, and that is the design. Every address the app
 * needs is read from the environment *when a request arrives* (`src/shared/config/server.ts`), never
 * at build time — otherwise the built image would be pinned to one deployment and "build once,
 * promote through environments" would be a lie. There is no `basePath` and no `NEXT_PUBLIC_*` here
 * for the same reason: both are baked into the output.
 */
const nextConfig: NextConfig = {
	experimental: {
		// TypeScript 7 no longer exposes the compiler API that Next's legacy
		// worker expects. Delegate production type-checking to the same CLI used
		// by `check-types` so local, CI, and build validation stay aligned.
		useTypeScriptCli: true,
		// The filesystem cache is on by default in Next 16.3 where the platform
		// supports it. Keep the build setting explicit: the Dockerfile persists
		// `.next/cache` between builds, so self-hosted builds benefit as well.
		turbopackFileSystemCacheForBuild: process.env.NEXT_BUILD_CACHE !== "false",
	},

	/**
	 * Cache Components (`'use cache'`, App Shells) and Partial Prefetching. Together they give the
	 * dashboard instant navigations: each route's static chrome is prefetched once and painted on
	 * click, while its session-scoped data streams into the Suspense fallbacks.
	 *
	 * Nothing here is cached on the server. Every read is scoped to the visitor's session, so the
	 * only `'use cache'` in the app is the gateway's public model catalog, which is unauthenticated.
	 */
	cacheComponents: true,
	partialPrefetching: true,

	/**
	 * The runtime image is `oven/bun` and has no `node` binary, so the container serves the traced
	 * standalone bundle with `bun .next/standalone/apps/dashboard/server.js`. Tracing has to start at
	 * the workspace root or it misses the hoisted node_modules in the repo root.
	 */
	output: "standalone",
	outputFileTracingRoot: join(here, "../.."),

	// Development only: the default corner covers the operator at the foot of the sidebar.
	devIndicators: { position: "bottom-right" },

	async headers() {
		return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
	},
};

export default nextConfig;
