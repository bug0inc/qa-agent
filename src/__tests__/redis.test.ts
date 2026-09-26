import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const hgetall = vi.fn();
const hset = vi.fn();
const expire = vi.fn();
const disconnect = vi.fn();

vi.mock("ioredis", () => {
  class MockRedis {
    hgetall = hgetall;
    hset = hset;
    expire = expire;
    disconnect = disconnect;
  }
  return { default: MockRedis };
});

vi.mock("../config", () => ({
  getConfig: vi.fn(() => ({ redis: { url: "redis://localhost:6379" } })),
}));

vi.mock("../logger", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  getRedis,
  resetRedis,
  redisHGetAll,
  redisHSet,
  redisExpire,
} from "../redis";
import { getConfig } from "../config";
import { logger } from "../logger";

describe("redis safe helpers (TOCTOU / error resilience)", () => {
  beforeEach(() => {
    resetRedis();
    hgetall.mockReset();
    hset.mockReset();
    expire.mockReset();
    disconnect.mockReset();
    vi.mocked(logger.warn).mockClear();
    vi.mocked(getConfig).mockReturnValue({
      redis: { url: "redis://localhost:6379" },
    } as ReturnType<typeof getConfig>);
  });

  afterEach(() => {
    resetRedis();
  });

  it("redisHGetAll returns hash data on success", async () => {
    hgetall.mockResolvedValue({ locator: "#btn", action: "click" });
    const result = await redisHGetAll("step:flow:click");
    expect(result).toEqual({ locator: "#btn", action: "click" });
    expect(hgetall).toHaveBeenCalledWith("step:flow:click");
  });

  it("redisHGetAll returns {} and does not throw when hgetall fails", async () => {
    hgetall.mockRejectedValue(new Error("Connection is closed"));
    await expect(redisHGetAll("step:flow:x")).resolves.toEqual({});
    expect(logger.warn).toHaveBeenCalled();
  });

  it("redisHGetAll returns {} when Redis is not configured", async () => {
    vi.mocked(getConfig).mockReturnValue({} as ReturnType<typeof getConfig>);
    resetRedis();
    await expect(redisHGetAll("k")).resolves.toEqual({});
    expect(hgetall).not.toHaveBeenCalled();
  });

  it("redisHSet returns true on success and false on failure without throwing", async () => {
    hset.mockResolvedValue(1);
    await expect(redisHSet("k", { a: "1" })).resolves.toBe(true);

    hset.mockRejectedValue(new Error("READONLY"));
    await expect(redisHSet("k", { a: "1" })).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("redisExpire returns false on failure without throwing", async () => {
    expire.mockRejectedValue(new Error("timeout"));
    await expect(redisExpire("k", 60)).resolves.toBe(false);
  });

  it("resetRedis nulls the client before disconnect (no dangling module ref)", async () => {
    const client = getRedis();
    expect(client).toBeTruthy();
    resetRedis();
    expect(disconnect).toHaveBeenCalled();
    hgetall.mockResolvedValue({});
    await expect(redisHGetAll("after-reset")).resolves.toEqual({});
  });

  it("safe helpers re-resolve client after resetRedis mid-flight (TOCTOU)", async () => {
    hgetall.mockImplementation(async () => {
      resetRedis();
      return { ok: "1" };
    });
    await expect(redisHGetAll("k")).resolves.toEqual({ ok: "1" });
    hgetall.mockResolvedValue({});
    await expect(redisHGetAll("k2")).resolves.toEqual({});
  });
});