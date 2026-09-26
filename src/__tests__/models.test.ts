import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveModel } from "../models";
import { configure, resetConfig } from "../config";
import { ConfigurationError } from "../errors";

describe("models", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws ConfigurationError if litellm gateway is used but LITELLM_BASE_URL is missing", () => {
    configure({ ai: { gateway: "litellm" } });
    delete process.env.LITELLM_BASE_URL;

    expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    expect(() => resolveModel("google/gemini-3-flash")).toThrow(/LITELLM_BASE_URL isn't set/);
  });

  it("resolves model using litellm gateway when LITELLM_BASE_URL is provided", () => {
    configure({ ai: { gateway: "litellm" } });
    process.env.LITELLM_BASE_URL = "http://localhost:4000/v1";
    // It should not throw and return a wrapped language model
    const model = resolveModel("google/gemini-3-flash");
    expect(model).toBeDefined();
    // Vercel AI SDK language models are objects with an execute property among others
    expect(typeof model).toBe("object");
  });

  it("accepts model IDs when routing via litellm gateway", () => {
    configure({ ai: { gateway: "litellm" } });
    process.env.LITELLM_BASE_URL = "http://localhost:4000/v1";
    
    // We can't easily inspect the internal modelId of the wrapped model in a unit test
    // without mocking the openai package, but we can verify it doesn't crash
    const model = resolveModel("google/gemini-3-flash");
    expect(model).toBeDefined();
    
    // And standard names should work too
    const bedrockModel = resolveModel("bedrock/claude-3-sonnet");
    expect(bedrockModel).toBeDefined();
  });
});
