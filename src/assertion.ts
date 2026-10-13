import { generateText, ModelMessage, Output } from "ai";
import { z } from "zod";
import { getConsensusPolicy, getModelId } from "./config";
import { ASSERTION_MODEL_TIMEOUT, THINKING_BUDGET_DEFAULT } from "./constants";
import { logger } from "./logger";
import { resolveModel } from "./models";
import { AssertionResult, AssertionOptions } from "./types";
import { resolvePage, safeSnapshot, withTimeout } from "./utils";
import { trackUsage } from "./cost";

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

/**
 * Multi-model consensus assertion engine.
 * Runs Claude and Gemini in parallel; if they disagree, a third model (arbiter) makes the final call.
 * An assertion passes only if both models agree (or the arbiter decides).
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

    // Claude assertion function
    const getClaudeAssertion = async (): Promise<AssertionResult> => {
      // First get Claude's text response with thinking if enabled
      const modelId = getModelId("assertionPrimary");
      const result = await generateText({
        model: resolveModel(modelId),
        temperature: 0,
        providerOptions: thinkingEnabled
          ? {
            anthropic: {
              thinking: { type: "enabled", budgetTokens: THINKING_BUDGET_DEFAULT },
            },
            openrouter: {
              reasoning: { max_tokens: THINKING_BUDGET_DEFAULT },
            },
          }
          : undefined,
        messages,
      });

      if (result.usage) {
        await trackUsage(modelId, result.usage);
      }

      // Convert Claude's response to structured format using Haiku
      const haikuResult = await generateText({
        model: resolveModel(modelId),
        temperature: 0.1,
        prompt: `Convert the following text output into a valid JSON object with the specified properties:\n\n${result.text}`,
        output: Output.object({ schema: assertionSchema }),
      });

      if (haikuResult.usage) {
        await trackUsage(modelId, haikuResult.usage);
      }

      return haikuResult.output;
    };

    // Gemini assertion function
    const getGeminiAssertion = async (): Promise<AssertionResult> => {
      const modelId = getModelId("assertionSecondary");
      const result = await generateText({
        model: resolveModel(modelId),
        temperature: 0,
        providerOptions: thinkingEnabled
          ? {
            google: {
              thinkingConfig: {
                thinkingBudget: THINKING_BUDGET_DEFAULT,
              },
            },
            openrouter: {
              reasoning: { max_tokens: THINKING_BUDGET_DEFAULT },
            },
          }
          : undefined,
        messages,
        output: Output.object({ schema: assertionSchema }),
      });

      if (result.usage) {
        await trackUsage(modelId, result.usage);
      }

      return result.output;
    };

    // Arbiter function using Gemini 2.5 Pro with thinking enabled
    const getArbiterDecision = async (
      claudeResult: AssertionResult,
      geminiResult: AssertionResult,
    ): Promise<AssertionResult> => {
      const arbiterPrompt = `
You are an AI arbiter tasked with resolving a disagreement between two AI models about an assertion.

Claude's Assessment:
- Assertion Passed: ${claudeResult.assertionPassed}
- Confidence: ${claudeResult.confidenceScore}%
- Reasoning: ${claudeResult.reasoning}

Gemini's Assessment:
- Assertion Passed: ${geminiResult.assertionPassed}
- Confidence: ${geminiResult.confidenceScore}%
- Reasoning: ${geminiResult.reasoning}

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

Please carefully review the evidence (screenshot and accessibility snapshot (when provided)) and make the final determination. Consider both models' reasoning but make your own independent assessment.

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

      const modelId = getModelId("assertionArbiter");
      const result = await generateText({
        model: resolveModel(modelId),
        temperature: 0,
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: THINKING_BUDGET_DEFAULT,
            },
          },
          openrouter: {
            reasoning: { max_tokens: THINKING_BUDGET_DEFAULT },
          },
        },
        messages: arbiterMessages,
        output: Output.object({ schema: assertionSchema }),
      });

      if (result.usage) {
        await trackUsage(modelId, result.usage);
      }

      return result.output;
    };

    const runAssertion = async (attempt = 0): Promise<AssertionResult> => {
      try {
        // Run both models in parallel for speed optimization
        const [claudeResult, geminiResult] = await Promise.all([
          withTimeout(getClaudeAssertion(), ASSERTION_MODEL_TIMEOUT),
          withTimeout(getGeminiAssertion(), ASSERTION_MODEL_TIMEOUT),
        ]);

        // Check if models disagree on assertionPassed
        if (claudeResult.assertionPassed !== geminiResult.assertionPassed) {
          const policy = getConsensusPolicy();

          if (policy === "fail-on-disagreement") {
            logger.debug(
              "Models disagree on assertion result; failing per consensusPolicy=fail-on-disagreement.",
            );
            const lower = Math.min(
              claudeResult.confidenceScore,
              geminiResult.confidenceScore,
            );
            return {
              assertionPassed: false,
              confidenceScore: Math.round(lower),
              reasoning:
                `Assertion failed: models disagreed and consensusPolicy is "fail-on-disagreement".\n` +
                `Claude (passed=${claudeResult.assertionPassed}, ${claudeResult.confidenceScore}%): ${claudeResult.reasoning}\n` +
                `Gemini (passed=${geminiResult.assertionPassed}, ${geminiResult.confidenceScore}%): ${geminiResult.reasoning}`,
            };
          }

          logger.debug("Models disagree on assertion result, consulting arbiter...");
          const arbiterResult = await withTimeout(
            getArbiterDecision(claudeResult, geminiResult),
            ASSERTION_MODEL_TIMEOUT,
          );

          return {
            assertionPassed: arbiterResult.assertionPassed,
            confidenceScore: arbiterResult.confidenceScore,
            reasoning: arbiterResult.reasoning,
          };
        }

        // Assertion passes only if both models agree it should pass
        const assertionPassed = claudeResult.assertionPassed && geminiResult.assertionPassed;

        // Calculate average confidence score
        const confidenceScore = (claudeResult.confidenceScore + geminiResult.confidenceScore) / 2;

        // For now take Gemini's reasoning for simplicity
        const reasoning = geminiResult.reasoning;

        return {
          assertionPassed,
          confidenceScore: Math.round(confidenceScore),
          reasoning,
        };
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
