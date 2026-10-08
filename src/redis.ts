import Redis from "ioredis";
import { getConfig } from "./config";
import { logger } from "./logger";

let client: Redis | null = null;
let initialized = false;

function initRedisHandlers(client: Redis): void {
  // Handle connection errors gracefully without crashing
  client.on("error", (err) => {
    logger.warn(`Redis connection error: ${err.message}`);
  });

  client.on("connecting", () => {
    logger.debug("Redis: attempting to connect...");
  });

  client.on("ready", () => {
    logger.debug("Redis: connected and ready");
  });

  client.on("reconnecting", () => {
    logger.debug("Redis: reconnecting after connection loss...");
  });
}
/**
 * Returns a memoized Redis client. Reads `configure({ redis: { url } })` first,
 * then falls back to `process.env.REDIS_URL`. Returns null when neither is set,
 * which disables step caching, {{global.*}} placeholders, and project data.
 *
 * Lazy: the connection is opened on first call so users can call `configure()`
 * before any Redis-dependent code path runs.
 *
 * Includes automatic reconnect strategy with exponential backoff to handle
 * transient failures without disabling caching mid-test.
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

  // Configure Redis client with reconnect strategy for transient failures
  client = new Redis(url, {
    // Connection timeouts
    connectTimeout: 10000,
    commandTimeout: 5000,

    // Reconnect strategy: retry with exponential backoff, max 10 retries
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000); // Cap at 2 seconds
      if (times > 10) {
        logger.error(`Redis: max reconnection attempts (${times}) exceeded`);
        return null; // Stop retrying
      }
      logger.debug(`Redis: reconnection attempt ${times}, retrying in ${delay}ms`);
      return delay;
    },

    // Reconnect on READONLY errors
    reconnectOnError: (err) => {
      const targetError = "READONLY";
      if (err.message.includes(targetError)) {
        // Only reconnect if error is a READONLY error
        return true;
      }
      return false;
    },
  });
  initRedisHandlers(client);

  return client;
}

/** @internal Reset the memoized client. Used for testing only. */
export function resetRedis() {
  client?.disconnect();
  client = null;
  initialized = false;
}
