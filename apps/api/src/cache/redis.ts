import { readFileSync } from "node:fs";
import { log } from "#logging/log.ts";
import { env } from "#config/env.ts";
import { Redis } from "ioredis";

/**
 * Shared Redis client for router state (cooldowns, in-flight, TPM/RPM), atomic rate limiting (Lua)
 * and the response cache.
 *
 * `rediss://` enables TLS, and the certificate is verified: a cache that holds budgets and rate
 * limits must not be reachable by whoever can intercept the link. A self-signed setup supplies its
 * CA in REDIS_TLS_CA; REDIS_TLS_INSECURE opts out explicitly. `redis://` is plaintext, for a private
 * network.
 */
export function redisTlsOptions(config: {
	url: string;
	ca?: string | undefined;
	insecure: boolean;
}): { tls?: { rejectUnauthorized: boolean; ca?: string } } {
	if (!config.url.startsWith("rediss://")) {
		return {};
	}
	if (config.insecure) {
		log.warn(
			"redis",
			"TLS certificate verification is disabled (REDIS_TLS_INSECURE)",
		);
		return { tls: { rejectUnauthorized: false } };
	}
	if (config.ca === undefined) {
		return { tls: { rejectUnauthorized: true } };
	}
	const ca = config.ca.startsWith("file:")
		? readFileSync(config.ca.slice("file:".length), "utf8")
		: config.ca;
	return { tls: { rejectUnauthorized: true, ca } };
}

export const redis = new Redis(env.REDIS_URL, {
	maxRetriesPerRequest: 3,
	// A command or a connection attempt that hangs fails instead, so a stalled Redis degrades
	// requests rather than holding them open.
	commandTimeout: 5000,
	connectTimeout: 5000,
	...redisTlsOptions({
		url: env.REDIS_URL,
		ca: env.REDIS_TLS_CA,
		insecure: env.REDIS_TLS_INSECURE,
	}),
});

// ioredis emits 'error' on every connection failure; without a listener Node reports it as an
// "Unhandled error event". We log it at debug level (ioredis keeps retrying on its own).
redis.on("error", (err: Error) => {
	log.debug("redis", "connection error", { err });
});

/** Health ping, answered within two seconds or reported down. */
export async function pingRedis(): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			redis.ping().then((pong) => pong === "PONG"),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 2000);
			}),
		]);
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function closeRedis(): Promise<void> {
	try {
		await redis.quit();
	} catch {
		redis.disconnect();
	}
}
