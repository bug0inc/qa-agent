import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetConfig, configure, type CustomProviderConfig } from "../config";

// Mock dependencies that resolveModel uses internally
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn(),
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(),
}));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    gateway: vi.fn(),
  };
});
vi.mock("axiom/ai", () => ({
  wrapAISDKModel: vi.fn((model) => model),
}));
vi.mock("../instrumentation", () => ({
  isAxiomEnabled: vi.fn(() => false),
}));

describe("resolveModel — custom providers", () => {
  // We need to import resolveModel after mocks are set up
  let resolveModel: typeof import("../models").resolveModel;

  beforeEach(async () => {
    resetConfig();
    // Re-import to get fresh module state
    const models = await import("../models");
    resolveModel = models.resolveModel;
  });

  function createMockProvider(returnValue?: string): CustomProviderConfig {
    const languageModel = vi.fn((id: string) => returnValue ?? `resolved:${id}`);
    const createProvider = vi.fn(() => ({
      languageModel,
      textEmbeddingModel: vi.fn(),
    }));
    return { createProvider } as unknown as CustomProviderConfig;
  }

  function createMockProviderWithAliases(
    aliases: Record<string, string>,
  ): CustomProviderConfig {
    const languageModel = vi.fn((id: string) => `resolved:${id}`);
    const createProvider = vi.fn(() => ({
      languageModel,
      textEmbeddingModel: vi.fn(),
    }));
    return { createProvider, models: aliases } as unknown as CustomProviderConfig;
  }

  it("resolves model via custom provider prefix", () => {
    const cp = createMockProvider();
    const result = resolveModel("my-proxy/gpt-4", "none", { "my-proxy": cp });
    expect(result).toBe("resolved:gpt-4");
    expect(cp.createProvider).toHaveBeenCalledOnce();
  });

  it("resolves model via custom provider in gateway mode", () => {
    const cp = createMockProvider();
    const result = resolveModel(
      "google/gemini-3-flash",
      "llm-proxy",
      { "llm-proxy": cp },
    );
    expect(result).toBe("resolved:google/gemini-3-flash");
    expect(cp.createProvider).toHaveBeenCalledOnce();
  });

  it("applies model aliases in provider-prefix mode", () => {
    const cp = createMockProviderWithAliases({
      "gemini-flash": "google/gemini-3.5-flash-internal",
    });
    const result = resolveModel("my-proxy/gemini-flash", "none", {
      "my-proxy": cp,
    });
    expect(result).toBe("resolved:google/gemini-3.5-flash-internal");
  });

  it("applies model aliases in gateway mode", () => {
    const cp = createMockProviderWithAliases({
      "google/gemini-3-flash": "gemini-3-flash-corp",
    });
    const result = resolveModel("google/gemini-3-flash", "my-proxy", {
      "my-proxy": cp,
    });
    expect(result).toBe("resolved:gemini-3-flash-corp");
  });

  it("passes through model name when no alias matches", () => {
    const cp = createMockProviderWithAliases({
      "some-model": "other-model",
    });
    const result = resolveModel("my-proxy/gpt-4", "none", { "my-proxy": cp });
    // No alias for "gpt-4", so it passes through as-is
    expect(result).toBe("resolved:gpt-4");
  });

  it("caches provider instances (createProvider called once)", () => {
    const cp = createMockProvider();
    resolveModel("my-proxy/model-a", "none", { "my-proxy": cp });
    resolveModel("my-proxy/model-b", "none", { "my-proxy": cp });
    expect(cp.createProvider).toHaveBeenCalledOnce();
  });

  it("throws for unknown provider when no custom provider matches", () => {
    expect(() =>
      resolveModel("unknown-provider/model", "none"),
    ).toThrow("Unknown AI provider: unknown-provider");
  });

  it("falls back to built-in providers when custom provider doesn't match prefix", () => {
    const cp = createMockProvider();
    // "google/..." should NOT match custom provider "my-proxy"
    expect(() =>
      resolveModel("google/gemini-3-flash", "none", { "my-proxy": cp }),
    ).toThrow(); // Throws because GOOGLE_GENERATIVE_AI_API_KEY is not set in test
  });

  it("reads custom providers from global config when not passed explicitly", () => {
    const cp = createMockProvider();
    configure({
      ai: {
        providers: { "global-proxy": cp },
      },
    });
    const result = resolveModel("global-proxy/some-model");
    expect(result).toBe("resolved:some-model");
    expect(cp.createProvider).toHaveBeenCalledOnce();
  });

  it("handles nested model names with slashes in provider-prefix mode", () => {
    const cp = createMockProvider();
    const result = resolveModel("my-proxy/org/model-name", "none", {
      "my-proxy": cp,
    });
    // Model name should be "org/model-name"
    expect(result).toBe("resolved:org/model-name");
  });
});
