import { getDashboardSettings } from "#db/repos/dashboardSettings.ts";
import { GatewayError } from "#core/errors.ts";
import { redis } from "#cache/redis.ts";

/**
 * Failed-login lockout. Three counters, all reserved atomically before the password is checked:
 *
 *  - the (username, client IP) pair, limited to `loginMaxAttempts`. This is the lock a real person
 *    meets, and nobody at another address can trip it for them.
 *  - the username alone, with a ceiling many times higher and an expiry that doubles each time the
 *    ceiling is passed. It stops a distributed attack on one account without letting a third party
 *    lock its owner out with a handful of requests.
 *  - the client IP alone, with the same higher ceiling. It stops one address spraying many
 *    usernames, where every pair counter would stay low.
 *
 * Reserving first (increment, then reject over the limit) closes the check-then-act race in which
 * concurrent guesses all passed a read of the counter before any failure was recorded. A success
 * releases only its own pair's reservation, so signing into an account one controls cannot reset
 * the counters an attack on another account built up.
 *
 * This is deliberately separate from `ratelimit/`, which meters paid inference against a virtual key
 * and reconciles token spend afterwards. Nothing here is metered or reconciled — it just counts.
 */
const PREFIX = "login-fail:v2";
/** The username and IP ceilings, as a multiple of `loginMaxAttempts`. */
const CEILING_FACTOR = 10;
/** The longest the username lock may grow to under backoff. */
const MAX_LOCK_SECONDS = 24 * 60 * 60;

/** Usernames are validated at creation with this pattern; the root operator is the one exception. */
const USERNAME = /^[a-zA-Z0-9._-]{3,64}$/u;

// KEYS: the counters. ARGV[1] lockout ttl, ARGV[2] max ttl, then per key: its limit and whether it
// backs off (1/0). Every counter is incremented; returns {blocked, retryAfterSeconds}.
const RESERVE_LUA = `
local ttl = tonumber(ARGV[1])
local maxTtl = tonumber(ARGV[2])
local blocked = 0
local retry = 0
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[1 + i * 2])
  local backoff = ARGV[2 + i * 2] == '1'
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('EXPIRE', key, ttl) end
  if count > limit then
    blocked = 1
    local keyTtl = redis.call('TTL', key)
    if backoff then
      -- Each further limit's worth of failures doubles the lock, up to maxTtl.
      local grown = math.min(maxTtl, ttl * (2 ^ math.floor((count - 1) / limit)))
      if grown > keyTtl then
        redis.call('EXPIRE', key, grown)
        keyTtl = grown
      end
    end
    if keyTtl > retry then retry = keyTtl end
  end
end
return {blocked, retry}
`;

function pairKey(username: string, ip: string): string {
	return `${PREFIX}:p:${username}:${ip}`;
}

function usernameKey(username: string): string {
	return `${PREFIX}:u:${username}`;
}

function ipKey(ip: string): string {
	return `${PREFIX}:i:${ip}`;
}

function normalize(username: string): string {
	return username.toLowerCase();
}

/**
 * Whether a username could belong to an account: the pattern accounts are created with, or the
 * root operator's configured name. Anything else is refused without a per-username counter, so a
 * client cannot create unbounded keys by inventing usernames.
 */
export function isPlausibleUsername(
	username: string,
	rootUser: string | null,
): boolean {
	return (
		USERNAME.test(username) ||
		(rootUser !== null && normalize(username) === normalize(rootUser))
	);
}

export interface LoginAttempt {
	/** Releases this attempt's pair reservation after a successful sign-in. */
	succeeded: () => Promise<void>;
}

/**
 * Reserves one sign-in attempt before the credentials are checked; throws 429 when any counter is
 * over its limit. A failed attempt needs nothing further: the reservation is the failure count.
 */
export async function reserveLoginAttempt(
	username: string,
	ip: string | null,
	rootUser: string | null,
): Promise<LoginAttempt> {
	const { loginMaxAttempts, loginLockoutMinutes } =
		await getDashboardSettings();
	const ttl = loginLockoutMinutes * 60;
	const name = normalize(username);
	const plausible = isPlausibleUsername(username, rootUser);
	const ceiling = loginMaxAttempts * CEILING_FACTOR;
	// [key, limit, backs off]. Without a client address the username counter is the only per-person
	// lock, so it takes the pair's limit.
	const counters: [string, number, boolean][] = [];
	if (plausible && ip) {
		counters.push([pairKey(name, ip), loginMaxAttempts, false]);
	}
	if (plausible) {
		counters.push([usernameKey(name), ip ? ceiling : loginMaxAttempts, true]);
	}
	if (ip) {
		counters.push([ipKey(ip), ceiling, false]);
	}
	if (counters.length > 0) {
		const [blocked, retryAfter] = (await redis.eval(
			RESERVE_LUA,
			counters.length,
			...counters.map(([key]) => key),
			String(ttl),
			String(MAX_LOCK_SECONDS),
			...counters.flatMap(([, limit, backoff]) => [
				String(limit),
				backoff ? "1" : "0",
			]),
		)) as [number, number];
		if (Number(blocked) === 1) {
			throw new GatewayError({
				class: "rate_limit",
				code: "login_locked_out",
				message: `Too many failed login attempts for "${username}"`,
				publicMessage: "Too many failed login attempts. Try again later.",
				headers: { "retry-after": String(Math.max(1, Number(retryAfter))) },
			});
		}
	}
	return {
		succeeded: async () => {
			if (plausible && ip) {
				await redis.del(pairKey(name, ip));
			}
		},
	};
}
