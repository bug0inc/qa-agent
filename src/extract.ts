import { generateText, Output } from "ai";
import { z } from "zod";
import { getModelId } from "./config";
import { resolveModel } from "./models";
import { trackUsage } from "./cost";

const extractionSchema = z.object({
  extractedValue: z.string().describe("The extracted value based on the prompt"),
});

/**
 * Extracts data from a page snapshot and URL using AI.
 * Uses Gemini 2.5 Flash for fast, accurate extraction.
 *
 * @param snapshot - The accessibility snapshot of the page
 * @param url - The current page URL
 * @param prompt - The extraction prompt describing what to extract
 * @returns The extracted value as a string
 *
 * @example
 * ```typescript
 * const token = await extractDataWithAI({
 *   snapshot: await safeSnapshot(page),
 *   url: page.url(),
 *   prompt: 'Extract the token query parameter value from the URL'
 * });
 * // Returns: "abc123"
 * ```
 */
export async function extractDataWithAI({
  snapshot,
  url,
  prompt,
}: {
  snapshot: string;
  url: string;
  prompt: string;
}): Promise<string> {
  const modelId = getModelId("utility");
  const result = await generateText({
    model: resolveModel(modelId),
    temperature: 0,
    output: Output.object({ schema: extractionSchema }),
    prompt: `You are an AI assistant that extracts specific data from web pages.

Given the following page snapshot and URL, extract the value described in the extraction prompt.

<URL>
${url}
</URL>

<PageSnapshot>
${snapshot}
</PageSnapshot>

<ExtractionPrompt>
${prompt}
</ExtractionPrompt>

<Rules>
- Extract exactly what is requested in the prompt
- If extracting from the URL, parse query parameters, path segments, or hash values as needed
- If extracting from the page content, find the relevant text in the snapshot
- Return only the extracted value, not the surrounding context
- If the value cannot be found, return an empty string
</Rules>

Return the extracted value.`,
  });

  if (result.usage) {
    await trackUsage(modelId, result.usage);
  }

  return result.output.extractedValue;
}

/**
 * Runs an `extract` step: pulls a value off the current page with AI and stores
 * it under the requested scope so later steps can reference it via placeholder.
 *
 * - scope "local" (default) → stored as {{run.<as>}} in `localValues`, available
 *   only within the current runSteps call.
 * - scope "global" → stored as {{global.<as>}} in `globalValues` and persisted to
 *   Redis under `executionId`, so subsequent runSteps calls with the same
 *   executionId can read it. Requires `executionId`.
 */
export async function applyExtraction({
  extract,
  tabManager,
  localValues,
  globalValues,
  executionId,
}: {
  extract: ExtractionConfig;
  tabManager: ReturnType<typeof createTabManager>;
  localValues: LocalPlaceholders;
  globalValues?: GlobalPlaceholders;
  executionId?: string;
}): Promise<void> {
  const snapshot = await safeSnapshot(tabManager);
  const url = tabManager.active().url();
  const extracted = await extractDataWithAI({
    snapshot,
    url,
    prompt: extract.prompt,
  });

  const scope = extract.scope ?? "local";

  if (scope === "global") {
    if (!executionId || !globalValues) {
      // Should be caught earlier in processPlaceholders, but guard defensively.
      throw new ValidationError(
        `extract with scope "global" requires an executionId. Cannot extract "${extract.as}" into the global scope.`,
      );
    }
    const placeholderKey = `{{global.${extract.as}}}`;
    globalValues[placeholderKey] = extracted;
    // Persist so subsequent runSteps calls with the same executionId can read it.
    await saveGlobalValues(executionId, globalValues);
    logger.info(`Extracted {{global.${extract.as}}}: "${extracted}"`);
  } else {
    const placeholderKey = `{{run.${extract.as}}}`;
    localValues[placeholderKey] = extracted;
    logger.info(`Extracted {{run.${extract.as}}}: "${extracted}"`);
  }
}
