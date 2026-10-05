import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIModelError, ConfigurationError } from "../errors";

const {
  mockGoogleFn,
  mockAnthropicFn,
  mockOpenAIFn,
  mockOpenRouterFn,
  mockCloudflareGoogleFn,
  mockCloudflareAnthropicFn,
  mockGateway,
} = vi.hoisted(() => ({
  mockGoogleFn: vi.fn((_model: string) => ({ type: "google-model" })),
  mockAnthropicFn: vi.fn((_model: string) => ({ type: "anthropic-model" })),
  mockOpenAIFn: vi.fn((_model: string) => ({ type: "openai-model" })),
  mockOpenRouterFn: vi.fn((_model: string) => ({ type: "openrouter-model" })),
  mockCloudflareGoogleFn: vi.fn((_model: string) => ({ type: "cf-google-model" })),
  mockCloudflareAnthropicFn: vi.fn((_model: string) => ({ type: "cf-anthropic-model" })),
  mockGateway: vi.fn((_modelId: string) => ({ type: "vercel-gateway-model" })),
}));

vi.mock("../instrumentation", () => ({
  isAxiomEnabled: () => false,
  initTelemetry: vi.fn(),
}));

vi.mock("axiom/ai", () => ({
  wrapAISDKModel: vi.fn((m) => m),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn((opts: Record<string, unknown> | undefined) =>
    opts?.baseURL ? mockCloudflareAnthropicFn : mockAnthropicFn,
  ),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: vi.fn((opts: Record<string, unknown>) =>
    opts.baseURL ? mockCloudflareGoogleFn : mockGoogleFn,
  ),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn((_opts?: Record<string, unknown>) => mockOpenAIFn),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => mockOpenRouterFn),
}));

vi.mock("ai", () => ({
  gateway: mockGateway,
}));

vi.mock("../config", () => ({
  getConfig: vi.fn(() => ({ ai: { gateway: "none" } })),
  resetConfig: vi.fn(),
}));

import { resolveModel } from "../models";
import { getConfig } from "../config";

function setEnv(key: string, value: string) {
  process.env[key] = value;
}

function clearEnv(...keys: string[]) {
  for (const k of keys) delete process.env[k];
}

function resetProviders() {
  mockGoogleFn.mockClear();
  mockAnthropicFn.mockClear();
  mockOpenAIFn.mockClear();
  mockOpenRouterFn.mockClear();
  mockCloudflareGoogleFn.mockClear();
  mockCloudflareAnthropicFn.mockClear();
  mockGateway.mockClear();
  (getConfig as ReturnType<typeof vi.fn>).mockClear();
}

const ALL_PROVIDER_ENVS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODEZEN_API_KEY",
  "AI_GATEWAY_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_GATEWAY",
  "CLOUDFLARE_AI_GATEWAY_API_KEY",
];

function setAllEnvVars() {
  setEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test-google-key");
  setEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  setEnv("OPENAI_API_KEY", "test-openai-key");
  setEnv("OPENROUTER_API_KEY", "test-openrouter-key");
  setEnv("OPENCODEZEN_API_KEY", "test-opencodezen-key");
  setEnv("AI_GATEWAY_API_KEY", "test-gateway-key");
  setEnv("CLOUDFLARE_ACCOUNT_ID", "test-cf-account");
  setEnv("CLOUDFLARE_AI_GATEWAY", "test-cf-gateway");
  setEnv("CLOUDFLARE_AI_GATEWAY_API_KEY", "test-cf-gateway-key");
}

describe("resolveModel", () => {
  afterEach(() => {
    clearEnv(...ALL_PROVIDER_ENVS);
  });

  // ── Missing API key errors (must run before providers are cached) ──

  describe("missing API key errors", () => {
    beforeEach(() => {
      setAllEnvVars();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "none" } });
    });

    it("throws ConfigurationError when GOOGLE_GENERATIVE_AI_API_KEY is missing", () => {
      clearEnv("GOOGLE_GENERATIVE_AI_API_KEY");
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when ANTHROPIC_API_KEY is missing", () => {
      clearEnv("ANTHROPIC_API_KEY");
      expect(() => resolveModel("anthropic/claude-3-5-sonnet")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when OPENAI_API_KEY is missing", () => {
      clearEnv("OPENAI_API_KEY");
      expect(() => resolveModel("openai/gpt-4o")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when OPENROUTER_API_KEY is missing", () => {
      clearEnv("OPENROUTER_API_KEY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "openrouter" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when OPENCODEZEN_API_KEY is missing", () => {
      clearEnv("OPENCODEZEN_API_KEY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "opencodezen" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when AI_GATEWAY_API_KEY is missing for vercel", () => {
      clearEnv("AI_GATEWAY_API_KEY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "vercel" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when CLOUDFLARE_ACCOUNT_ID is missing", () => {
      clearEnv("CLOUDFLARE_ACCOUNT_ID");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "cloudflare" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when CLOUDFLARE_AI_GATEWAY is missing", () => {
      clearEnv("CLOUDFLARE_AI_GATEWAY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "cloudflare" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when GOOGLE key missing for cloudflare google", () => {
      clearEnv("GOOGLE_GENERATIVE_AI_API_KEY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "cloudflare" } });
      expect(() => resolveModel("google/gemini-3-flash")).toThrow(ConfigurationError);
    });

    it("throws ConfigurationError when ANTHROPIC key missing for cloudflare anthropic", () => {
      clearEnv("ANTHROPIC_API_KEY");
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "cloudflare" } });
      expect(() => resolveModel("anthropic/claude-haiku-4.5")).toThrow(ConfigurationError);
    });
  });

  // ── Direct provider routing (gateway: "none") ──────────────────────

  describe("direct provider routing (gateway: none)", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "none" } });
    });

    it("routes google/* models to Google provider with alias resolution", () => {
      const model = resolveModel("google/gemini-3-flash");
      expect(model).toEqual({ type: "google-model" });
      expect(mockGoogleFn).toHaveBeenCalledWith("gemini-3-flash-preview");
    });

    it("routes anthropic/* models to Anthropic provider with alias resolution", () => {
      const model = resolveModel("anthropic/claude-haiku-4.5");
      expect(model).toEqual({ type: "anthropic-model" });
      expect(mockAnthropicFn).toHaveBeenCalledWith("claude-haiku-4-5");
    });

    it("routes openai/* models to OpenAI provider", () => {
      const model = resolveModel("openai/gpt-4o");
      expect(model).toEqual({ type: "openai-model" });
      expect(mockOpenAIFn).toHaveBeenCalledWith("gpt-4o");
    });

    it("passes through non-aliased google model names", () => {
      resolveModel("google/gemini-2.5-flash");
      expect(mockGoogleFn).toHaveBeenCalledWith("gemini-2.5-flash");
    });

    it("resolves anthropic alias claude-sonnet-4.6 to claude-sonnet-4-6", () => {
      resolveModel("anthropic/claude-sonnet-4.6");
      expect(mockAnthropicFn).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("throws AIModelError for unknown provider", () => {
      expect(() => resolveModel("unknown/model")).toThrow(AIModelError);
      expect(() => resolveModel("unknown/model")).toThrow("Unknown AI provider: unknown");
    });
  });

  // ── Vercel gateway ─────────────────────────────────────────────────

  describe("vercel gateway", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "vercel" } });
    });

    it("routes through gateway() with the model id as-is", () => {
      const model = resolveModel("google/gemini-3-flash");
      expect(mockGateway).toHaveBeenCalledWith("google/gemini-3-flash");
      expect(model).toEqual({ type: "vercel-gateway-model" });
    });

    it("does not apply alias resolution for vercel gateway", () => {
      resolveModel("anthropic/claude-haiku-4.5");
      expect(mockGateway).toHaveBeenCalledWith("anthropic/claude-haiku-4.5");
    });
  });

  // ── OpenRouter gateway ─────────────────────────────────────────────

  describe("openrouter gateway", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "openrouter" } });
    });

    it("routes through OpenRouter provider", () => {
      const model = resolveModel("anthropic/claude-3-5-sonnet");
      expect(mockOpenRouterFn).toHaveBeenCalledWith("anthropic/claude-3-5-sonnet");
      expect(model).toEqual({ type: "openrouter-model" });
    });

    it("resolves openrouter alias google/gemini-3-flash to google/gemini-3-flash-preview", () => {
      resolveModel("google/gemini-3-flash");
      expect(mockOpenRouterFn).toHaveBeenCalledWith("google/gemini-3-flash-preview");
    });

    it("does not apply alias when model id is not in openrouter alias map", () => {
      resolveModel("anthropic/claude-3-5-sonnet");
      expect(mockOpenRouterFn).toHaveBeenCalledWith("anthropic/claude-3-5-sonnet");
    });
  });

  // ── OpenCodeZen gateway ────────────────────────────────────────────

  describe("opencodezen gateway", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "opencodezen" } });
    });

    it("routes through OpenCodeZen (OpenAI) provider with alias resolution", () => {
      const model = resolveModel("anthropic/claude-haiku-4.5");
      expect(mockOpenAIFn).toHaveBeenCalledWith("claude-haiku-4-5");
      expect(model).toEqual({ type: "openai-model" });
    });

    it("resolves opencodezen alias google/gemini-3.1-pro-preview to gemini-3.1-pro", () => {
      resolveModel("google/gemini-3.1-pro-preview");
      expect(mockOpenAIFn).toHaveBeenCalledWith("gemini-3.1-pro");
    });

    it("strips provider prefix for non-aliased models", () => {
      resolveModel("openai/gpt-4o");
      expect(mockOpenAIFn).toHaveBeenCalledWith("gpt-4o");
    });

    it("resolves claude-sonnet-4.6 alias", () => {
      resolveModel("anthropic/claude-sonnet-4.6");
      expect(mockOpenAIFn).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("resolves claude-opus-4.7 alias", () => {
      resolveModel("anthropic/claude-opus-4.7");
      expect(mockOpenAIFn).toHaveBeenCalledWith("claude-opus-4-7");
    });

    it("resolves claude-haiku-4.5 alias via alternate key", () => {
      resolveModel("anthropic/claude-haiku-4.5");
      expect(mockOpenAIFn).toHaveBeenCalledWith("claude-haiku-4-5");
    });
  });

  // ── Cloudflare gateway ─────────────────────────────────────────────

  describe("cloudflare gateway", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "cloudflare" } });
    });

    it("routes google models through Cloudflare Google provider with alias", () => {
      const model = resolveModel("google/gemini-3-flash");
      expect(model).toEqual({ type: "cf-google-model" });
      expect(mockCloudflareGoogleFn).toHaveBeenCalledWith("gemini-3-flash-preview");
      expect(mockGoogleFn).not.toHaveBeenCalled();
    });

    it("routes anthropic models through Cloudflare Anthropic provider with alias", () => {
      const model = resolveModel("anthropic/claude-haiku-4.5");
      expect(model).toEqual({ type: "cf-anthropic-model" });
      expect(mockCloudflareAnthropicFn).toHaveBeenCalledWith("claude-haiku-4-5");
      expect(mockAnthropicFn).not.toHaveBeenCalled();
    });

    it("resolves anthropic alias claude-sonnet-4.6 through Cloudflare", () => {
      resolveModel("anthropic/claude-sonnet-4.6");
      expect(mockCloudflareAnthropicFn).toHaveBeenCalledWith("claude-sonnet-4-6");
    });

    it("passes through non-aliased google model names via Cloudflare", () => {
      resolveModel("google/gemini-2.5-flash");
      expect(mockCloudflareGoogleFn).toHaveBeenCalledWith("gemini-2.5-flash");
    });

    it("throws AIModelError for unsupported Cloudflare provider", () => {
      expect(() => resolveModel("openai/gpt-4o")).toThrow(AIModelError);
      expect(() => resolveModel("openai/gpt-4o")).toThrow(
        "Cloudflare AI Gateway routing is not configured for provider: openai",
      );
    });
  });

  // ── Gateway override parameter ─────────────────────────────────────

  describe("gatewayOverride parameter", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
    });

    it("uses gatewayOverride when provided, ignoring global config", () => {
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "none" } });
      const model = resolveModel("google/gemini-3-flash", "vercel");
      expect(mockGateway).toHaveBeenCalledWith("google/gemini-3-flash");
      expect(model).toEqual({ type: "vercel-gateway-model" });
    });

    it("falls back to global config when gatewayOverride is undefined", () => {
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "vercel" } });
      const model = resolveModel("google/gemini-3-flash", undefined);
      expect(mockGateway).toHaveBeenCalledWith("google/gemini-3-flash");
      expect(model).toEqual({ type: "vercel-gateway-model" });
    });

    it("falls back to 'none' when both override and config are absent", () => {
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: {} });
      const model = resolveModel("google/gemini-3-flash");
      expect(mockGoogleFn).toHaveBeenCalled();
      expect(model).toEqual({ type: "google-model" });
    });
  });

  // ── Model ID parsing edge cases ────────────────────────────────────

  describe("model ID parsing", () => {
    beforeEach(() => {
      setAllEnvVars();
      resetProviders();
      (getConfig as ReturnType<typeof vi.fn>).mockReturnValue({ ai: { gateway: "none" } });
    });

    it("handles model ids with multiple slashes (rest joined)", () => {
      resolveModel("openai/org/model-name");
      expect(mockOpenAIFn).toHaveBeenCalledWith("org/model-name");
    });

    it("handles model id with no model part (just provider)", () => {
      resolveModel("google");
      expect(mockGoogleFn).toHaveBeenCalledWith("");
    });

    it("handles model id with single slash", () => {
      resolveModel("anthropic/claude-3-5-sonnet");
      expect(mockAnthropicFn).toHaveBeenCalledWith("claude-3-5-sonnet");
    });
  });
});
