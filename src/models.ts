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
let _bedrock: ((modelId: string) => LanguageModel) | null = null;

function getGoogleProvider() {
  if (!_google) {
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
      throw new ConfigurationError(
        "GOOGLE_GENERATIVE_AI_API_KEY isn't set. Add it to your environment (for example: export GOOGLE_GENERATIVE_AI_API_KEY=your_key), or use a gateway: configure({ ai: { gateway: 'vercel' } }) with AI_GATEWAY_API_KEY, configure({ ai: { gateway: 'openrouter' } }) with OPENROUTER_API_KEY, or configure({ ai: { gateway: 'cloudflare' } }) with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY, GOOGLE_GENERATIVE_AI_API_KEY, and CLOUDFLARE_AI_GATEWAY_API_KEY. See .env.example for reference.",
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
        "ANTHROPIC_API_KEY isn't set. Add it to your environment (for example: export ANTHROPIC_API_KEY=your_key), or use a gateway: configure({ ai: { gateway: 'vercel' } }) with AI_GATEWAY_API_KEY, configure({ ai: { gateway: 'openrouter' } }) with OPENROUTER_API_KEY, or configure({ ai: { gateway: 'cloudflare' } }) with CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_GATEWAY, ANTHROPIC_API_KEY, and CLOUDFLARE_AI_GATEWAY_API_KEY. See .env.example for reference.",
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

function getOpenCodeZenProvider() {
  if (!_opencodezen) {
    if (!process.env.OPENCODEZEN_API_KEY) {
      throw new ConfigurationError(
        "OPENCODEZEN_API_KEY isn't set. Add it to your environment (for example: export OPENCODEZEN_API_KEY=your_key). See .env.example for reference.",
      );
    }
    _opencodezen = createOpenAI({
      baseURL: "https://opencode.ai/zen/v1",
      apiKey: process.env.OPENCODEZEN_API_KEY,
    });
  }
  return _opencodezen;
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

function getBedrockProvider() {
  if (!_bedrock) {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env.AWS_SESSION_TOKEN;

    if (!region) {
      throw new ConfigurationError(
        "AWS_REGION isn't set. Add it to your environment (for example: export AWS_REGION=us-east-1). AWS Bedrock requires AWS_REGION and either AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) or a default AWS credential provider chain. See .env.example for reference.",
      );
    }

    // Dynamically require the ESM-only Bedrock package
    // This throws a more helpful error than a static import would
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createAmazonBedrock } = require("@ai-sdk/amazon-bedrock");
      
      // AWS SDK will automatically use the credential provider chain if keys aren't explicitly provided
      // This includes: environment variables, shared credentials file, EC2 instance metadata, etc.
      
      // Type assertion is safe: @ai-sdk/amazon-bedrock v5 returns LanguageModelV4,
      // which is structurally compatible with LanguageModel (v2/v3) at runtime.
      // The V4 spec extends V3 without breaking changes to the interface used by generateText().
      _bedrock = createAmazonBedrock({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
      }) as (modelId: string) => LanguageModel;
    } catch (error) {
      throw new ConfigurationError(
        `Failed to load AWS Bedrock provider. This may be due to the ESM/CommonJS module incompatibility. ` +
        `Ensure you're using Node.js >= 18.0.0 and have @ai-sdk/amazon-bedrock installed. Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return _bedrock;
}

/**
 * Maps canonical model names to direct Google/Anthropic/Bedrock API names.
 * Only needed where the gateway name differs from the direct provider name.
 * Add new entries here when providers rename or graduate models.
 */
const MODEL_DIRECT_ALIASES: Record<string, string> = {
  "gemini-3-flash": "gemini-3-flash-preview",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-haiku-4.5": "claude-haiku-4-5",
  // Bedrock model aliases - map friendly names to Bedrock model IDs
  "claude-3-5-sonnet": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  "claude-3-5-haiku": "anthropic.claude-3-5-haiku-20241022-v1:0",
  "claude-3-opus": "anthropic.claude-3-opus-20240229-v1:0",
  "claude-3-sonnet": "anthropic.claude-3-sonnet-20240229-v1:0",
  "claude-3-haiku": "anthropic.claude-3-haiku-20240307-v1:0",
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
 * Input format: "provider/model-name" (e.g. "google/gemini-3-flash", "bedrock/claude-3-5-sonnet")
 *
 * Users always use canonical IDs (gateway-style). When using direct providers,
 * model names are automatically mapped to the correct provider-specific names
 * (e.g. "gemini-3-flash" → "gemini-3-flash-preview" for Google's direct API,
 * "claude-3-5-sonnet" → "anthropic.claude-3-5-sonnet-20241022-v2:0" for Bedrock).
 *
 * When gateway is "vercel", routes through the Vercel AI Gateway as-is.
 * When gateway is "openrouter", routes through OpenRouter.
 * When gateway is "cloudflare", routes through Cloudflare AI Gateway using the
 * provider-native paths (google-ai-studio, anthropic) so provider-specific fields
 * like Gemini's thought_signature pass through unchanged.
 * When gateway is "none" (default), creates a direct provider instance with alias resolution.
 * All paths wrap the model with wrapAISDKModel for tracing when Axiom is enabled.
 *
 * @param modelId - Canonical model id, e.g. "google/gemini-3-flash" or "bedrock/claude-3-5-sonnet".
 * @param gatewayOverride - Optional resolved gateway for this call. When omitted,
 *   falls back to the global `configure()` value. Pass this when a per-step or
 *   per-call `ai` override changes the gateway for a single resolution.
 */
export function resolveModel(modelId: string, gatewayOverride?: AIGateway): LanguageModel {
  const gatewayConfig = gatewayOverride ?? getConfig().ai?.gateway ?? "none";

  if (gatewayConfig === "vercel") {
    if (!process.env.AI_GATEWAY_API_KEY) {
      throw new ConfigurationError(
        "AI_GATEWAY_API_KEY isn't set. To use the Vercel AI Gateway, add AI_GATEWAY_API_KEY to your environment. If you'd rather use direct provider keys, call configure({ ai: { gateway: 'none' } }) and set GOOGLE_GENERATIVE_AI_API_KEY and/or ANTHROPIC_API_KEY and/or AWS credentials for Bedrock.",
      );
    }
    return wrapModel(gateway(modelId));
  }

  if (gatewayConfig === "openrouter") {
    return wrapModel(getOpenRouterProvider()(resolveOpenRouterModelId(modelId)));
  }

  if (gatewayConfig === "opencodezen") {
    return wrapModel(getOpenCodeZenProvider()(resolveOpenCodeZenModelId(modelId)));
  }

  const [provider, ...rest] = modelId.split("/");
  const modelName = rest.join("/");

  if (gatewayConfig === "cloudflare") {
    switch (provider) {
      case "google":
        return wrapModel(getCloudflareGoogleProvider()(resolveDirectModelName(modelName)));
      case "anthropic":
        return wrapModel(getCloudflareAnthropicProvider()(resolveDirectModelName(modelName)));
      case "bedrock":
        throw new AIModelError(
          "Cloudflare AI Gateway routing is not supported for AWS Bedrock. Use gateway: 'none' with Bedrock.",
        );
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
    case "bedrock":
      return wrapModel(getBedrockProvider()(resolveDirectModelName(modelName)));
    default:
      throw new AIModelError(`Unknown AI provider: ${provider}`);
  }
}
