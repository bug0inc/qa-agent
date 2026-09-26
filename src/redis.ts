import Redis from "ioredis";
import { getConfig } from "./config";
import { logger } from "./logger";

let client: Redis | null = null;
let initialized = false;

/**
 * Returns a memoized Redis client. Reads `configure({ redis: { url } })` first,
 * then falls back to `process.env.REDIS_URL`. Returns null when neither is set,
 * which disables step caching, {{global.*}} placeholders, and project data.
 *
 * Lazy: the connection is opened on first call so users can call `configure()`
 * before any Redis-dependent code path runs.
 *
 * Do not hold the returned client across `await` boundaries for long-lived work.
 * Prefer {@link redisHGetAll}, {@link redisHSet}, and {@link redisExpire}, which
 * re-resolve the client at call time and degrade gracefully on errors (avoids
 * TOCTOU races with `resetRedis()` / disconnect mid-execution).
 */
export function getRedis(): Redis | null {
  if (initialized) return client;
  initialized = true;

  const url = getConfig().redis?.url ?? process.env.REDIS_URL;
  if (!url) {
    logger.warn(
      "Redis URL not set (configure({ redis: { url } }) or REDIS_URL). " +
        "Step caching, global placeholders, and project data are disabled.",
    );
    return null;
  }

  client = new Redis(url);
  return client;
}

/** @internal Reset the memoized client. Used for testing only. */
export function resetRedis() {
  // Null the module ref before disconnect so concurrent getRedis()/safe helpers
  // cannot observe a half-dead client mid-teardown (TOCTOU with in-flight awaits).
  const prev = client;
  client = null;
  initialized = false;
  prev?.disconnect();
}

/**
 * Safe HGETALL: resolves the client at call time and never throws.
 * Returns {} when Redis is unavailable, reset mid-flight, or the command fails.
 */
export async function redisHGetAll(key: string): Promise<Record<string, string>> {
  const redis = getRedis();
  if (!redis) return {};
  try {
    const values = await redis.hgetall(key);
    return values ?? {};
  } catch (err) {
    logger.warn({ err, key }, "Redis hgetall failed; treating cache as empty");
    return {};
  }
}

/**
 * Safe HSET: resolves the client at call time and never throws.
 * Returns true on success, false when Redis is unavailable or the command fails.
 */
export async function redisHSet(
  key: string,
  data: Record<string, string>,
): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.hset(key, data);
    return true;
  } catch (err) {
    logger.warn({ err, key }, "Redis hset failed; cache write skipped");
    return false;
  }
}

/**
 * Safe EXPIRE: resolves the client at call time and never throws.
 * Returns true on success, false when Redis is unavailable or the command fails.
 */
export async function redisExpire(key: string, seconds: number): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  try {
    await redis.expire(key, seconds);
    return true;
  } catch (err) {
    logger.warn({ err, key }, "Redis expire failed; TTL not applied");
    return false;
  }
}