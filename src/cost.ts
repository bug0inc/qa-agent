import { logger } from "./logger";
import { redis } from "./redis";

export interface ModelPricing {
  promptTokenPricePerMillion: number;
  completionTokenPricePerMillion: number;
}

/**
 * Default pricing for models used in Passmark.
 * Prices are in USD per 1 million tokens.
 * Data sourced from provider documentation as of April 2026.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "google/gemini-3-flash": {
    promptTokenPricePerMillion: 0.1,
    completionTokenPricePerMillion: 0.4,
  },
  "google/gemini-3.1-pro-preview": {
    promptTokenPricePerMillion: 1.25,
    completionTokenPricePerMillion: 5.0,
  },
  "anthropic/claude-haiku-4.5": {
    promptTokenPricePerMillion: 0.25,
    completionTokenPricePerMillion: 1.25,
  },
  "google/gemini-2.5-flash": {
    promptTokenPricePerMillion: 0.1,
    completionTokenPricePerMillion: 0.4,
  },
  "gpt-5.5": {
    promptTokenPricePerMillion: 2.5,
    completionTokenPricePerMillion: 10.0,
  },
};

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Tracks LLM usage and calculates the cost of the call.
 * Updates a global cost counter in Redis if available for cross-worker synchronization.
 *
 * @param modelId - The canonical model ID (e.g. "google/gemini-3-flash")
 * @param usage - Token usage data from the AI SDK
 */
export async function trackUsage(modelId: string, usage: Usage) {
  const pricing = DEFAULT_PRICING[modelId] || DEFAULT_PRICING["google/gemini-3-flash"];
  
  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;
  
  const promptCost = (promptTokens / 1_000_000) * pricing.promptTokenPricePerMillion;
  const completionCost = (completionTokens / 1_000_000) * pricing.completionTokenPricePerMillion;
  const totalCost = promptCost + completionCost;

  logger.debug(
    `[Cost] Model: ${modelId} | Prompt: ${promptTokens} | Completion: ${completionTokens} | Cost: $${totalCost.toFixed(6)}`
  );

  if (redis) {
    try {
      // Use a global key to track cumulative cost across all test workers
      const executionId = process.env.executionId || "default";
      const costKey = `cost:total:${executionId}`;
      const modelCostKey = `cost:model:${modelId}:${executionId}`;

      await Promise.all([
        redis.incrbyfloat(costKey, totalCost),
        redis.incrbyfloat(modelCostKey, totalCost),
      ]);
    } catch (err) {
      logger.warn(`Failed to update cost in Redis: ${err}`);
    }
  }
}

/**
 * Retrieves the total estimated cost for the current execution.
 * @returns Total cost in USD
 */
export async function getTotalCost(): Promise<number> {
  if (!redis) return 0;
  
  const executionId = process.env.executionId || "default";
  const cost = await redis.get(`cost:total:${executionId}`);
  return cost ? parseFloat(cost) : 0;
}
