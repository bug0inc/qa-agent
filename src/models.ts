import { AIModelError, ConfigurationError } from "./errors";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { gateway, type LanguageModel } from "ai";
import { wrapAISDKModel } from "axiom/ai";
import { type AIGateway, getConfig } from "./config";
import { isAxiomEnabled } from "./instrumentation";

function wrapModel(model: LanguageModel): LanguageModel {
  return isAxiomEnabled() ? wrapAISDKModel(model) : model;
}

let _google: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _anthropic: ReturnType<typeof createAnthropic> | null = null;
let _openai: ReturnType<typeof createOpenAI> | null = null;
let _openrouter: ReturnType<typeof createOpenRouter> | null = null;
let _opencodezen: ReturnType<typeof createOpenAI> | null = null;
let _cloudflareGoogle: ReturnType<typeof createGoogleGenerativeAI> | null = null;
let _cloudflareAnthropic: ReturnType<typeof createAnthropic> | null = null;
let _litellm: ReturnType<typeof createOpenAI> | null = null;

function getGoogleProvider() {
  if (!_google) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new ConfigurationError(
        "GOOGLE_GENERATIVE_AI_API_KEY isn't set. Add it to your environment (for example: export GOOGLE_GENERATIVE_AI_API_KEY=your_key), or use a gateway: configure({ ai: { gateway: 'vercel' } }) with AI_GATEWAY_API_KEY, configure({ ai: { gateway: 'openrouter' } }) with OPENROUTER_API_KEY, configure({ ai: { gateway: 'litellm' } }) with LITELLM_BASE_URL, or configure({ ai: { gateway: 'cloudflare' } }) with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY, GOOGLE_GENERATIVE_AI_API_KEY, and CLOUDFLARE_AI_GATEWAY_API_KEY. See .env.example for reference.",
      );
    }
    _google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
  }
  return _google;
}

function getAnthropicProvider() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigurationError(
        "ANTHROPIC_API_KEY isn't set. Add it to your environment (for example: export ANTHROPIC_API_KEY=your_key), or use a gateway: configure({ ai: { gateway: 'vercel' } }) with AI_GATEWAY_API_KEY, configure({ ai: { gateway: 'openrouter' } }) with OPENROUTER_API_KEY, configure({ ai: { gateway: 'litellm' } }) with LITELLM_BASE_URL, or configure({ ai: { gateway: 'cloudflare' } }) with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY, ANTHROPIC_API_KEY, and CLOUDFLARE_AI_GATEWAY_API_KEY. See .env.example for reference.",
      );
    }
    _anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return _anthropic;
}

function getOpenAIProvider() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new ConfigurationError(
        "OPENAI_API_KEY isn't set. Add it to your environment (for example: export OPENAI_API_KEY=your_key), or use a gateway by calling configure({ ai: { gateway: 'vercel' } }) with AI_GATEWAY_API_KEY, or configure({ ai: { gateway: 'openrouter' } }) with OPENROUTER_API_KEY. See .env.example for reference.",
      );
    }
    _openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return _openai;
}

function getOpenRouterProvider() {
  if (!_openrouter) {
    if (!process.env.OPENROUTER_API_KEY) {
      throw new ConfigurationError(
        "OPENROUTER_API_KEY isn't set. Add it to your environment (for example: export OPENROUTER_API_KEY=your_key). See .env.example for reference.",
      );
    }
    _openrouter = createOpenRouter({
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  return _openrouter;
}

function getLiteLLMProvider() {
  if (!_litellm) {
    if (!process.env.LITELLM_BASE_URL) {
      throw new ConfigurationError(
        "LITELLM_BASE_URL isn't set. To use the LiteLLM gateway, add LITELLM_BASE_URL to your environment (e.g. export LITELLM_BASE_URL=http://localhost:4000/v1). You may also need to set LITELLM_API_KEY.",
      );
    }
    _litellm = createOpenAI({
      apiKey: process.env.LITELLM_API_KEY || "dummy-key",
      baseURL: process.env.LITELLM_BASE_URL,
    });
  }
  return _litellm;
}

/**
 * Builds the per-provider Cloudflare AI Gateway base URL and (optional)
 * `cf-aig-authorization` header. We route through Cloudflare's native
 * provider paths (not the Unified/OpenAI-compat endpoint) so that
 * provider-specific fields — notably Gemini's `thought_signature` on
 * thinking models — pass through unmodified.
 *
 * @see https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/
 * @see https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/
 */
function getCloudflareGatewayConfig(providerPath: string): {
  baseURL: string;
  headers?: Record<string, string>;
} {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const gatewayName = process.env.CLOUDFLARE_AI_GATEWAY;
  if (!accountId || !gatewayName) {
    throw new ConfigurationError(
      "Cloudflare AI Gateway requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_GATEWAY (gateway name). You must also set the upstream provider key (GOOGLE_GENERATIVE_AI_API_KEY and/or ANTHROPIC_API_KEY). If the gateway is authenticated, also set CLOUDFLARE_AI_GATEWAY_API_KEY. See .env.example for reference.",
    );
  }
  const cfAigToken = process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  return {
    baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}/${providerPath}`,
    headers: cfAigToken ? { "cf-aig-authorization": `Bearer ${cfAigToken}` } : undefined,
  };
}

function getCloudflareGoogleProvider() {
  if (!_cloudflareGoogle) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new ConfigurationError(
        "GOOGLE_GENERATIVE_AI_API_KEY isn't set. Cloudflare AI Gateway proxies requests to Google AI Studio and requires your Google API key. Add GOOGLE_GENERATIVE_AI_API_KEY to your environment.",
      );
    }
    const { baseURL, headers } = getCloudflareGatewayConfig("google-ai-studio/v1beta");
    _cloudflareGoogle = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
      baseURL,
      headers,
    });
  }
  return _cloudflareGoogle;
}

function getCloudflareAnthropicProvider() {
  if (!_cloudflareAnthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new ConfigurationError(
        "ANTHROPIC_API_KEY isn't set. Cloudflare AI Gateway proxies requests to Anthropic and requires your Anthropic API key. Add ANTHROPIC_API_KEY to your environment.",
      );
    }
    const { baseURL, headers } = getCloudflareGatewayConfig("anthropic/v1");
    _cloudflareAnthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL,
      headers,
    });
  }
  return _cloudflareAnthropic;
}

/**
 * Maps canonical model names to direct Google/Anthropic API names.
 * Only needed where the gateway name differs from the direct provider name.
 * Add new entries here when providers rename or graduate models.
 */
const MODEL_DIRECT_ALIASES: Record<string, string> = {
  "gemini-3-flash": "gemini-3-flash-preview",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-haiku-4.5": "claude-haiku-4-5",
};

function resolveDirectModelName(modelName: string): string {
  return MODEL_DIRECT_ALIASES[modelName] ?? modelName;
}

/**
 * Maps canonical model IDs (provider/model) to OpenRouter model IDs.
 * OpenRouter uses its own naming — add entries here when they differ from canonical IDs.
 */
const OPENROUTER_MODEL_ALIASES: Record<string, string> = {
  "google/gemini-3-flash": "google/gemini-3-flash-preview",
};

function resolveOpenRouterModelId(modelId: string): string {
  return OPENROUTER_MODEL_ALIASES[modelId] ?? modelId;
}

function resolveLiteLLMModelId(modelId: string): string {
  if (modelId.startsWith("google/")) {
    return modelId.replace("google/", "gemini/");
  }
  return modelId;
}

/**
 * Maps canonical model IDs (provider/model) to OpenCode Zen model IDs.
 * Zen strips the provider prefix and uses its own naming for some models.
 */
const OPENCODEZEN_MODEL_ALIASES: Record<string, string> = {
  "google/gemini-3.1-pro-preview": "gemini-3.1-pro",
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5",
  "anthropic/claude-haiku-4-5": "claude-haiku-4-5",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
  "anthropic/claude-opus-4.7": "claude-opus-4-7",
  "anthropic/claude-opus-4-7": "claude-opus-4-7",
};

function resolveOpenCodeZenModelId(modelId: string): string {
  if (OPENCODEZEN_MODEL_ALIASES[modelId]) {
    return OPENCODEZEN_MODEL_ALIASES[modelId];
  }
  // Strip provider prefix: "google/gemini-3-flash" → "gemini-3-flash"
  const slashIndex = modelId.indexOf("/");
  return slashIndex !== -1 ? modelId.slice(slashIndex + 1) : modelId;
}

/**
 * Resolves a canonical model ID to a LanguageModel instance wrapped with Axiom instrumentation.
 * Input format: "provider/model-name" (e.g. "google/gemini-3-flash")
 *
 * Users always use canonical IDs (gateway-style). When using direct providers,
 * model names are automatically mapped to the correct provider-specific names
 * (e.g. "gemini-3-flash" → "gemini-3-flash-preview" for Google's direct API).
 *
 * When gateway is "vercel", routes through the Vercel AI Gateway as-is.
 * When gateway is "openrouter", routes through OpenRouter.
 * When gateway is "cloudflare", routes through Cloudflare AI Gateway using the
 * provider-native paths (google-ai-studio, anthropic) so provider-specific fields
 * like Gemini's thought_signature pass through unchanged.
 * When gateway is "none" (default), creates a direct provider instance with alias resolution.
 * All paths wrap the model with wrapAISDKModel for tracing when Axiom is enabled.
 *
 * @param modelId - Canonical model id, e.g. "google/gemini-3-flash".
 * @param gatewayOverride - Optional resolved gateway for this call. When omitted,
 *   falls back to the global `configure()` value. Pass this when a per-step or
 *   per-call `ai` override changes the gateway for a single resolution.
 */
export function resolveModel(modelId: string, gatewayOverride?: AIGateway): LanguageModel {
  const gatewayConfig = gatewayOverride ?? getConfig().ai?.gateway ?? "none";

  if (gatewayConfig === "vercel") {
    if (!process.env.AI_GATEWAY_API_KEY) {
      throw new ConfigurationError(
        "AI_GATEWAY_API_KEY isn't set. To use the Vercel AI Gateway, add AI_GATEWAY_API_KEY to your environment. If you'd rather use direct provider keys, call configure({ ai: { gateway: 'none' } }) and set GOOGLE_GENERATIVE_AI_API_KEY and/or ANTHROPIC_API_KEY.",
      );
    }
    return wrapModel(gateway(modelId));
  }

  if (gatewayConfig === "openrouter") {
    return wrapModel(getOpenRouterProvider()(resolveOpenRouterModelId(modelId)));
  }

  if (gatewayConfig === "litellm") {
    return wrapModel(getLiteLLMProvider()(resolveLiteLLMModelId(modelId)));
  }

  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/");

  if (gatewayConfig === "cloudflare") {
    switch (provider) {
      case "google":
        return wrapModel(getCloudflareGoogleProvider()(resolveDirectModelName(modelName)));
      case "anthropic":
        return wrapModel(getCloudflareAnthropicProvider()(resolveDirectModelName(modelName)));
      default:
        throw new AIModelError(
          `Cloudflare AI Gateway routing is not configured for provider: ${provider}`,
        );
    }
  }

  switch (provider) {
    case "google":
      return wrapModel(getGoogleProvider()(resolveDirectModelName(modelName)));
    case "anthropic":
      return wrapModel(getAnthropicProvider()(resolveDirectModelName(modelName)));
    case "openai":
      return wrapModel(getOpenAIProvider()(resolveDirectModelName(modelName)));
    default:
      throw new AIModelError(`Unknown AI provider: ${provider}`);
  }
}
