import { generateText, ModelMessage, Output } from "ai";
import { z } from "zod";
import { getModelId, getAssertionModelsList, getConsensusPolicy } from "./config";
import { ASSERTION_MODEL_TIMEOUT, THINKING_BUDGET_DEFAULT } from "./constants";
import { logger } from "./logger";
import { resolveModel } from "./models";
import { AssertionResult, AssertionOptions } from "./types";
import { resolvePage, safeSnapshot, withTimeout } from "./utils";
import { assertVideoFile, deleteGeminiFile, uploadVideoToGemini } from "./video";

const assertionSchema = z.object({
  assertionPassed: z.boolean().describe("Indicates whether the assertion passed or not."),
  confidenceScore: z
    .number()
    .describe("Confidence score of the assertion, between 0 and 100."),
  reasoning: z
    .string()
    .describe(
      "Brief explanation of the reasoning behind your decision - explain why the assertion passed or failed.",
    ),
});

type ModelAssertionFunction = () => Promise<AssertionResult>;

/**
 * Creates an assertion function for a specific model
 */
function createModelAssertionFunction(
  modelId: string,
  messages: ModelMessage[],
  thinkingEnabled: boolean
): ModelAssertionFunction {
  return async (): Promise<AssertionResult> => {
    // Check if it's a Google model (for provider-specific options)
    const lowerModelId = modelId.toLowerCase();
    const isGoogleModel = lowerModelId.includes("google") || lowerModelId.includes("gemini");
    const isAnthropicModel = lowerModelId.includes("anthropic") || lowerModelId.includes("claude");
    
    const providerOptions: Record<string, any> = {};
    
    if (thinkingEnabled) {
      if (isAnthropicModel) {
        providerOptions.anthropic = {
          thinking: { type: "enabled", budgetTokens: THINKING_BUDGET_DEFAULT },
        };
      } else if (isGoogleModel) {
        providerOptions.google = {
          thinkingConfig: {
            thinkingBudget: THINKING_BUDGET_DEFAULT,
          },
        };
      }
      
      // Always include openrouter reasoning option as fallback
      providerOptions.openrouter = {
        reasoning: { max_tokens: THINKING_BUDGET_DEFAULT },
      };
    }
    
    const { output } = await generateText({
      model: resolveModel(modelId),
      temperature: 0,
      providerOptions: Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
      messages,
      output: Output.object({ schema: assertionSchema }),
    });
    
    return output;
  };
}

/**
 * Creates an arbiter function to resolve disagreements between multiple model results
 */
function createArbiterFunction(
  modelResults: Array<{ modelId: string; result: AssertionResult }>,
  _messages: ModelMessage[],
  imageContent: Array<{ type: "image"; image: string }>,
  assertion: string,
  snapshot: string,
  images: string[] | undefined,
  thinkingEnabled: boolean = false
): ModelAssertionFunction {
  return async (): Promise<AssertionResult> => {
    const resultsSummary = modelResults
      .map(({ modelId, result }) => `
Model: ${modelId}
- Assertion Passed: ${result.assertionPassed}
- Confidence: ${result.confidenceScore}%
- Reasoning: ${result.reasoning}
`)
      .join("\n");

    const arbiterPrompt = `
You are an AI arbiter tasked with resolving a disagreement between multiple AI models about an assertion.

The following models evaluated the assertion and reached different conclusions:

${resultsSummary}

${!images
        ? `
<Snapshot>
${snapshot}
</Snapshot>
`
        : ""
      }

<Assertion>
${assertion}
</Assertion>

Please carefully review the evidence (screenshot and accessibility snapshot when provided) and make the final determination. Consider all models' reasoning but make your own independent assessment.

<Rules>
- Make your own independent evaluation based on the evidence
- Don't simply pick one model's answer - analyze the situation yourself
- Provide clear reasoning for your decision
- Be decisive - this is the final answer
- First use the attached screenshot(s) to visually inspect the page and try to verify the assertion.
- Only if the screenshot is not sufficient, use the accessibility snapshot (if supplied) to verify the assertion.
- Don't create additional assertion conditions on your own - only consider the exact assertion provided above.
- The assertion should pass if either the screenshot or the accessibility snapshot supports it.
- Don't be overly strict or pedantic about exact wording. Focus on the intent and objective of the assertion rather than literal text matching.
- Think like a practical QA tester - if the core functionality or state being asserted is present, the assertion should pass even if minor details differ.
</Rules>
`;

    const arbiterMessages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: arbiterPrompt,
          },
          ...imageContent,
        ],
      },
    ];

    const arbiterModelId = getModelId("assertionArbiter");
    const lowerArbiterModelId = arbiterModelId.toLowerCase();
    const isGoogleModel = lowerArbiterModelId.includes("google") || lowerArbiterModelId.includes("gemini");
    
    const providerOptions: Record<string, any> = {
      openrouter: {
        reasoning: { max_tokens: THINKING_BUDGET_DEFAULT },
      },
    };
    
    if (thinkingEnabled && isGoogleModel) {
      providerOptions.google = {
        thinkingConfig: {
          thinkingBudget: THINKING_BUDGET_DEFAULT,
        },
      };
    }
    
    const { output } = await generateText({
      model: resolveModel(arbiterModelId),
      temperature: 0,
      providerOptions,
      messages: arbiterMessages,
      output: Output.object({ schema: assertionSchema }),
    });

    return output;
  };
}

/**
 * Checks if all models agree on the assertion result
 */
function checkConsensus(results: AssertionResult[]): {
  hasConsensus: boolean;
  consensusResult?: AssertionResult;
  majorityResult?: AssertionResult;
  passedCount: number;
  failedCount: number;
} {
  const passedCount = results.filter(r => r.assertionPassed).length;
  const failedCount = results.length - passedCount;
  
  // Unanimous consensus
  if (passedCount === results.length || failedCount === results.length) {
    const avgConfidence = results.reduce((sum, r) => sum + r.confidenceScore, 0) / results.length;
    // For backward compatibility: 2 models use secondary (index 1), 3+ use first
    const reasoningIndex = results.length === 2 ? 1 : 0;
    
    return {
      hasConsensus: true,
      consensusResult: {
        assertionPassed: passedCount === results.length,
        confidenceScore: Math.round(avgConfidence),
        reasoning: results[reasoningIndex].reasoning,
      },
      passedCount,
      failedCount,
    };
  }
  
  // Majority vote (for 3+ models)
  if (results.length >= 3) {
    // Check for tie - if tie, return no majorityResult so arbiter is consulted
    if (passedCount === failedCount) {
      return {
        hasConsensus: false,
        passedCount,
        failedCount,
        // No majorityResult - this will trigger arbiter
      };
    }
    
    const majorityPassed = passedCount > failedCount;
    const majorityResults = results.filter(r => r.assertionPassed === majorityPassed);
    const avgConfidence = majorityResults.reduce((sum, r) => sum + r.confidenceScore, 0) / majorityResults.length;
    
    return {
      hasConsensus: false,
      majorityResult: {
        assertionPassed: majorityPassed,
        confidenceScore: Math.round(avgConfidence),
        reasoning: majorityResults[0].reasoning,
      },
      passedCount,
      failedCount,
    };
  }
  
  return {
    hasConsensus: false,
    passedCount,
    failedCount,
  };
}

/**
 * Multi-model consensus assertion engine.
 * Runs multiple AI models in parallel; if they disagree, an arbiter model makes the final call.
 * Supports both legacy primary/secondary and new assertionModels array configuration.
 * Automatically retries failed assertions once with a fresh page snapshot.
 *
 * @param options - Assertion configuration
 * @param options.page - The Playwright page instance to take snapshots from
 * @param options.assertion - Natural language assertion to validate (e.g. "The cart shows 3 items")
 * @param options.expect - Playwright expect function, used to fail the test on assertion failure
 * @param options.effort - "low" (default) or "high" — high enables thinking mode for deeper analysis
 * @param options.images - Optional base64 screenshot images to provide to the models
 * @param options.failSilently - When true, returns the result without failing the test
 * @param options.test - Playwright test instance for attaching metadata
 * @returns A string summary of the assertion result
 * @throws Fails the Playwright test via expect when assertion fails (unless failSilently is true)
 *
 * @example
 * ```typescript
 * // Using multiple models (new approach)
 * await assert({
 *   page,
 *   assertion: "The dashboard shows 3 active projects",
 *   expect,
 *   effort: "high",
 * });
 * ```
 */

export const assert = async ({
  page,
  assertion,
  test,
  expect,
  effort = "low",
  images,
  failSilently,
  maxRetries = 1,
  onRetry = (retryCount: number, previousResult: AssertionResult) => { },
  video,
  videoFilePath,
}: AssertionOptions): Promise<string> => {
  const thinkingEnabled = effort === "high";
  
  // Get the list of models to use for assertions
  const assertionModels = getAssertionModelsList();

  // Video assertion path: when a recorded video is provided, evaluate the
  // assertion against the full video using a video-capable Gemini model.
  // Consensus isn't available here (Claude doesn't accept video), so this is
  // a single-model call. The screenshot/snapshot path below is unchanged.
  if (video && videoFilePath) {
    logger.debug({ assertion, videoFilePath }, "Running video assertion path");
    const runVideoAssertion = async (): Promise<AssertionResult> => {
      const file = await uploadVideoToGemini(videoFilePath);
      try {
        return await assertVideoFile({
          assertion,
          fileUri: file.uri,
          fileMimeType: file.mimeType,
        });
      } finally {
        await deleteGeminiFile(file.name);
      }
    };

    let videoResult = await runVideoAssertion();
    for (let retry = 0; retry < maxRetries && !videoResult.assertionPassed; retry++) {
      logger.debug("Video assertion failed, retrying...");
      onRetry(retry, videoResult);
      videoResult = await runVideoAssertion();
    }

    test?.info().annotations.push({
      type: "AI Summary (video analysis)",
      description: videoResult.reasoning,
    });

    const status = videoResult.assertionPassed ? "✅ passed" : "❌ failed";
    if (!failSilently) {
      expect(videoResult.assertionPassed, videoResult.reasoning).toBe(true);
    }
    return `${videoResult.reasoning}\n\n[Assertion ${status}]`;
  }

  const runFullAssertion = async (): Promise<AssertionResult> => {
    const snapshot = await safeSnapshot(page);
    const imageContent = images
      ? images.map((image) => ({ type: "image" as const, image }))
      : [
        {
          type: "image" as const,
          image: (await resolvePage(page).screenshot({ fullPage: false })).toString("base64"),
        },
      ];

    const basePrompt = `
You are an AI-powered QA Agent designed to test web applications.

You have access to the following information. Based on this information, you'll tell us whether the assertion provided below should pass or not.
${!images
        ? `
- An accessibility snapshot of the current page, which provides a detailed structure of the DOM
- A screenshot of the current page`
        : "- Screenshots from various stages of the user flow"
      }

${!images
        ? `
<Snapshot>
${snapshot}
</Snapshot>
`
        : ""
      }

<Assertion>
${assertion}
</Assertion>

<Rules>
- First use the attached screenshot(s) to visually inspect the page and try to verify the assertion.
- Only if the screenshot is not sufficient, use the accessibility snapshot (if supplied) to verify the assertion.
- Don't create additional assertion conditions on your own - only consider the exact assertion provided above.
- The assertion should pass if either the screenshot or the accessibility snapshot supports it.
- Don't be overly strict or pedantic about exact wording. Focus on the intent and objective of the assertion rather than literal text matching.
- Think like a practical QA tester - if the core functionality or state being asserted is present, the assertion should pass even if minor details differ.
</Rules>

<OutputFormat>
    The output should contain the following information:
    - \`assertionPassed\`: A boolean indicating whether the assertion passed or not.
    - \`confidenceScore\`: A number between 0 and 100 indicating the confidence score of the assertion.
    - \`reasoning\`: A brief string explaining the reasoning behind the assertion.
</OutputFormat>

Never hallucinate. Be truthful and if you are not sure, use a low confidence score.
`;

    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: basePrompt,
          },
          ...imageContent,
        ],
      },
    ];

    const runAssertion = async (attempt = 0): Promise<AssertionResult> => {
      try {
        // Create assertion functions for all configured models
        const assertionFunctions = assertionModels.map(modelId => 
          createModelAssertionFunction(modelId, messages, thinkingEnabled)
        );
        
        // Run all models in parallel
        const results = await Promise.all(
          assertionFunctions.map(fn => withTimeout(fn(), ASSERTION_MODEL_TIMEOUT))
        );
        
        // Pair results with model IDs for potential arbiter use
        const modelResults = assertionModels.map((modelId, index) => ({
          modelId,
          result: results[index],
        }));
        
        // Check for consensus
        const consensus = checkConsensus(results);
        
        if (consensus.hasConsensus && consensus.consensusResult) {
          logger.debug(`All ${results.length} models agreed on assertion result`);
          return consensus.consensusResult;
        }

        const policy = getConsensusPolicy();
        if (policy === "fail-on-disagreement") {
          logger.debug(
            "Models disagree on assertion result; failing per consensusPolicy=fail-on-disagreement.",
          );
          const lower = Math.min(...results.map(r => r.confidenceScore));
          const reasons = modelResults.map(({ modelId, result }) => 
            `${modelId} (passed=${result.assertionPassed}, ${result.confidenceScore}%): ${result.reasoning}`
          ).join("\n");

          return {
            assertionPassed: false,
            confidenceScore: Math.round(lower),
            reasoning:
              `Assertion failed: models disagreed and consensusPolicy is "fail-on-disagreement".\n${reasons}`,
          };
        }
        
        // For 2 models with disagreement, use arbiter
        if (results.length === 2 && results[0].assertionPassed !== results[1].assertionPassed) {
          logger.debug("Two models disagree on assertion result, consulting arbiter...");
          const arbiterFn = createArbiterFunction(
            modelResults,
            messages,
            imageContent,
            assertion,
            snapshot,
            images,
            thinkingEnabled
          );
          return await withTimeout(arbiterFn(), ASSERTION_MODEL_TIMEOUT);
        }
        
        // For 3+ models with majority but not unanimous
        if (results.length >= 3 && consensus.majorityResult) {
          logger.debug(
            `Majority vote: ${consensus.passedCount} passed, ${consensus.failedCount} failed. ` +
            `Using majority result.`
          );
          return consensus.majorityResult;
        }
        
        // Fallback: Use arbiter for any unresolved cases (including ties)
        logger.debug("Consulting arbiter for final decision...");
        const arbiterFn = createArbiterFunction(
          modelResults,
          messages,
          imageContent,
          assertion,
          snapshot,
          images,
          thinkingEnabled
        );
        return await withTimeout(arbiterFn(), ASSERTION_MODEL_TIMEOUT);
        
      } catch (error) {
        if (attempt < 1) {
          logger.debug("Retrying assertion due to error...");
          return await runAssertion(attempt + 1);
        }
        logger.error({ err: error }, "Error running assertions after multiple retries");
        throw error;
      }
    };

    return await runAssertion();
  };

  // Run assertion with retry on failure
  let result = await runFullAssertion();

  for (let retry = 0; retry < maxRetries && !result.assertionPassed; retry++) {
    logger.debug("Assertion failed, retrying with fresh snapshot and screenshot...");
    onRetry(retry, result);
    result = await runFullAssertion();
  }

  const { assertionPassed, reasoning } = result;

  test?.info().annotations.push({
    type: "AI Summary",
    description: reasoning,
  });

  const expectStatus = assertionPassed ? "✅ passed" : "❌ failed";

  if (!failSilently) {
    expect(assertionPassed, reasoning).toBe(true);
  }

  return `${reasoning}\n\n[Assertion ${expectStatus}]`;
};
