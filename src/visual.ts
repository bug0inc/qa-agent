import { generateText, Output } from "ai";
import { resolveModel } from "./models";
import { getModelId } from "./config";
import { logger } from "./logger";
import { trackUsage } from "./cost";
import fs from "fs";
import { z } from "zod";
import { VisualDiffOptions, VisualExplanationResult } from "./types";
import { maybeWithSpan } from "./utils/telemetry";
import { withTimeout } from "./utils";
import { VISUAL_DIFF_EXPLANATION_TIMEOUT } from "./constants";
import { VisualRegressionError } from "./errors";

const visualExplanationSchema = z.object({
  explanation: z
    .string()
    .describe("A human-readable explanation of the visual differences between the two images."),
  isBug: z
    .boolean()
    .describe("Whether the change appears to be a functional bug or a legitimate UI tweak."),
  confidence: z.number().min(0).max(100).describe("Confidence score of the explanation (0-100)."),
  diffAreas: z
    .array(z.string())
    .optional()
    .describe("List of specific areas or elements that changed."),
});

/**
 * Resolves various image input formats into a Buffer.
 * Supports file paths, base64 data URLs, and Buffers.
 */
async function resolveImageBuffer(input: string | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  // Handle data URL (e.g. "data:image/png;base64,...")
  if (input.startsWith("data:")) {
    const base64 = input.split(",")[1];
    if (!base64) {
      throw new VisualRegressionError("Invalid base64 data URL provided as image input.");
    }
    return Buffer.from(base64, "base64");
  }

  // Handle file path
  if (fs.existsSync(input)) {
    try {
      return fs.readFileSync(input);
    } catch (err) {
      throw new VisualRegressionError(`Failed to read image from path: ${input}. ${err}`);
    }
  }

  // If it doesn't look like a path and isn't a Buffer/DataURL, maybe it's raw base64
  try {
    return Buffer.from(input, "base64");
  } catch (err) {
    throw new VisualRegressionError(
      `Unable to resolve image input. It is not a valid path, Buffer, or base64 string.`,
    );
  }
}

/**
 * Explains the visual differences between an "Expected" screenshot and the "Actual" page state.
 * Uses a Vision-capable AI model to generate a human-readable explanation, helping QA teams
 * distinguish between minor styling tweaks and breaking visual bugs.
 *
 * @param options - Configuration for the visual diff explanation
 * @param options.page - The Playwright page instance
 * @param options.expectedImage - The baseline image (path, Buffer, or base64)
 * @param options.actualImage - The failed state image (path, Buffer, or base64). If omitted, takes a fresh screenshot.
 * @param options.test - Playwright test instance for attaching rich annotations to the report.
 * @returns A structured explanation of the visual differences.
 *
 * @example
 * ```typescript
 * try {
 *   await expect(page).toHaveScreenshot('landing.png');
 * } catch (error) {
 *   await explainVisualDiff({
 *     page,
 *     expectedImage: 'test-snapshots/landing-linux.png',
 *     test,
 *   });
 *   throw error;
 * }
 * ```
 */
export async function explainVisualDiff({
  page,
  expectedImage,
  actualImage,
  test,
}: VisualDiffOptions): Promise<VisualExplanationResult> {
  return maybeWithSpan({ capability: "visual_regression", step: "explain_diff" }, async () => {
    logger.info("Generating AI explanation for visual regression failure...");

    try {
      // 1. Resolve images to Buffers
      let expectedBuffer: Buffer | undefined;
      if (expectedImage) {
        expectedBuffer = await resolveImageBuffer(expectedImage);
      }

      let actualBuffer: Buffer;
      if (actualImage) {
        actualBuffer = await resolveImageBuffer(actualImage);
      } else {
        logger.debug("No actual image provided, taking fresh screenshot...");
        actualBuffer = await page.screenshot({ fullPage: false });
      }

      // 2. Prepare model
      const modelId = getModelId("visualRegressionExplanation");
      const model = resolveModel(modelId);

      const prompt = `
You are an elite QA Automation Engineer and Visual UX Expert.
You have been tasked with explaining why a visual regression test failed.

Attached are two images:
1. **Expected Image (Baseline)**: The reference point that represents the "correct" UI state.
2. **Actual Image (Current)**: The current state of the application which failed the pixel-diff check.

### Objective
Provide a precise, human-readable explanation of the differences. Your goal is to help a developer or product manager quickly understand if this is a regression bug or a planned UI update.

### Analysis Requirements
- **Spatial Changes**: Note if elements moved, swapped positions, or if margins/padding changed.
- **Visual Styles**: Identify changes in fonts, colors, border-radius, or shadows.
- **Content Changes**: Note if text changed, icons were swapped, or images are missing.
- **Layout Integrity**: Identify if the layout broke or if elements are overlapping unexpectedly.

### Output Format
Be concise but technical. Avoid fluff.

<OutputFormat>
- \`explanation\`: A 2-3 sentence summary of the core differences.
- \`isBug\`: Boolean (true if it looks like a broken layout/missing asset, false if it looks like a clean styling update).
- \`confidence\`: 0-100 score of your assessment.
- \`diffAreas\`: Optional list of specific components or selectors that appear to have changed.
</OutputFormat>
`;

      // 3. Execute model call with timeout
      const result = await withTimeout(
        generateText({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...(expectedBuffer ? [{ type: "image" as const, image: expectedBuffer }] : []),
                { type: "image" as const, image: actualBuffer },
              ],
            },
          ],
          output: Output.object({ schema: visualExplanationSchema }),
        }),
        VISUAL_DIFF_EXPLANATION_TIMEOUT,
      );

      if (result.usage) {
        await trackUsage(modelId, result.usage);
      }

      const { explanation, isBug, confidence, diffAreas } = result.output;

      // 4. Format for Playwright Report
      const areasStr =
        diffAreas && diffAreas.length > 0
          ? `\n\n**Impacted Areas:**\n${diffAreas.map((a) => `- ${a}`).join("\n")}`
          : "";

      const judgmentEmoji = isBug ? "🚨 **Lately a BUG**" : "✨ **Likely a STYLING TWEAK**";
      const summary = `### 🔍 AI Visual Diff Analysis\n\n**Confidence:** ${confidence}%\n\n**Explanation:**\n${explanation}\n\n**Judgment:** ${judgmentEmoji}${areasStr}\n\n---\n*Analysis generated by Passmark AI Regression Engine*`;

      if (test) {
        test.info().annotations.push({
          type: "Visual Diff Analysis",
          description: summary,
        });
      }

      logger.info(`Successfully generated visual diff explanation (${confidence}% confidence).`);
      return result.output;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to generate visual diff explanation: ${message}`);

      if (error instanceof VisualRegressionError) {
        throw error;
      }
      throw new VisualRegressionError(`AI visual analysis failed: ${message}`);
    }
  });
}
