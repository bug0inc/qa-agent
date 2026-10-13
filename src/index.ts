import { StepExecutionError, ValidationError } from "./errors";

import {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "@playwright/test";
import { generateText, hasToolCall, Output, stepCountIs } from "ai";
import { withSpan } from "axiom/ai";
import shortid from "shortid";
import { initTelemetry, isAxiomEnabled } from "./instrumentation";

import { maybeWithSpan } from "./utils/telemetry";
import { z } from "zod";
import { buildRunStepsPrompt, buildRunUserFlowPrompt } from "./prompts";
import { getRedis } from "./redis";
import { getAItools } from "./tools";
import { RunStepsOptions, UserFlowOptions } from "./types";
import {
  runLocatorCode,
  safeSnapshot,
  verifyActionEffect,
  waitForCondition,
  waitForDOMStabilization,
} from "./utils";

import { assert } from "./assertion";
import { VideoRecorder } from "./video";
import {
  getDynamicEmail,
  processPlaceholders,
  replacePlaceholders,
  resolveEmailPlaceholders,
} from "./data-cache";
import { resolveAI } from "./config";
import { runCUALoop, buildRunStepsPromptCUA, buildRunUserFlowPromptCUA } from "./cua";
import { applyExtraction } from "./extract";
import { logger } from "./logger";
import { resolveModel } from "./models";
export * from "./visual";
import { trackUsage } from "./cost";
import { runSecureScript } from "./utils/secure-script-runner";
import { createTabManager } from "./utils/tab-manager";
import {
  CACHED_ACTION_TIMEOUT,
  INITIAL_DOM_STABILIZATION_IDLE,
  MAX_RETRIES,
  STEP_EXECUTION_MAX_STEPS,
  STEP_EXECUTION_TIMEOUT,
  THINKING_BUDGET_DEFAULT,
  USER_FLOW_MAX_STEPS,
} from "./constants";

/**
 * Executes a sequence of test steps using AI with intelligent caching.
 * Each step is described in natural language and executed via browser automation.
 * Successfully executed steps are cached in Redis for faster subsequent runs.
 *
 * @param options - Configuration including page, steps, assertions, and callbacks
 * @param options.page - The Playwright page instance
 * @param options.userFlow - Name of the user flow (used as cache key prefix)
 * @param options.steps - Array of steps to execute, each with a description and optional data
 * @param options.bypassCache - When true, skips cache and forces AI execution for all steps
 * @param options.assertions - Optional assertions to verify after step execution
 * @param options.executionId - Links multiple runSteps calls to share {{global.*}} placeholders
 * @param options.onStepStart - Callback fired when a step begins execution
 * @param options.onStepEnd - Callback fired when a step completes
 * @param options.onReasoning - Callback fired with AI reasoning for each tool call
 * @throws Rethrows step execution timeout errors
 *
 * @example
 * ```typescript
 * await runSteps({
 *   page,
 *   userFlow: "Checkout Flow",
 *   steps: [
 *     { description: "Add item to cart" },
 *     { description: "Fill in email", data: { value: "{{run.email}}" } },
 *   ],
 *   assertions: [{ assertion: "Order confirmation is displayed" }],
 *   expect,
 * });
 * ```
 */
export const runSteps = async ({
  page,
  test,
  expect,
  userFlow,
  steps,
  auth,
  bypassCache = false,
  onStepStart,
  onStepEnd,
  onReasoning,
  assertions,
  projectId,
  executionId,
  failAssertionsSilently,
  ai: callLevelAi,
}: RunStepsOptions) => {
  executionId = executionId || process.env.executionId;

  // Initialize Axiom telemetry now that any user `configure()` call has run.
  // Idempotent — re-entry is a no-op.
  initTelemetry();

  // Track all open tabs for this run. The active page is updated automatically
  // when a new tab opens, or explicitly via the `switchToTab` step field.
  const tabManager = createTabManager(page);

  const redis = getRedis();
  if (!redis) {
    logger.warn(
      "Redis not configured. Step caching is disabled — all steps will use AI execution.",
    );
    if (executionId) {
      logger.warn(
        "{{global.*}} placeholders will not persist across runSteps calls without Redis.",
      );
    }
  }

  // Check if this is a Playwright retry - if so, bypass cache and use AI only
  const isPlaywrightRetry = test ? test.info().retry > 0 : false;
  if (isPlaywrightRetry) {
    logger.debug(
      `Playwright retry detected (retry #${test!.info().retry
      }). Bypassing cache and using AI only.`,
    );
  }

  // Process dynamic placeholders before running steps
  const { processedSteps, processedAssertions, localValues, globalValues, projectDataValues, hasGlobalPlaceholders } =
    await processPlaceholders(steps, assertions, executionId, projectId);

  logger.info(`Starting step-by-step execution of ${processedSteps.length} steps.`);

  // If any assertion opted into video evaluation, record a single screencast
  // spanning the full step run. One recording is shared across all video
  // assertions in this call; cleanup happens in a finally block below.
  const needsVideo = processedAssertions?.some((a) => a.video) ?? false;
  let videoRecorder: VideoRecorder | undefined;
  if (needsVideo) {
    videoRecorder = new VideoRecorder(tabManager.active());
    try {
      await videoRecorder.start();
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to start screencast — video assertions will fall back to screenshot/snapshot.",
      );
      videoRecorder = undefined;
    }
  }

  let errorInStepExecution,
    stepThatFailed: string = "";
  for (let i = 0; i < processedSteps.length; i++) {
    // Resolve email placeholders lazily just before step execution.
    // Only use the shared global email when these steps actually reference
    // {{global.*}} placeholders;
    const dynamicEmail = getDynamicEmail(localValues, globalValues, hasGlobalPlaceholders);

    // Re-process step data and waitUntil with current localValues to pick up extracted values from previous steps
    let currentStep = processedSteps[i];
    if (currentStep.data) {
      currentStep = {
        ...currentStep,
        data: Object.fromEntries(
          Object.entries(currentStep.data).map(([k, v]) => [
            k,
            replacePlaceholders(v, localValues, globalValues, projectDataValues),
          ]),
        ),
      };
    }

    if (currentStep.waitUntil) {
      currentStep = {
        ...currentStep,
        waitUntil: replacePlaceholders(
          currentStep.waitUntil,
          localValues,
          globalValues,
          projectDataValues,
        ),
      };
    }

    const step = await resolveEmailPlaceholders(currentStep, dynamicEmail);
    const id = shortid.generate();

    // Resolve effective AI config for this step. Step > runSteps call > global.
    const effectiveAi = resolveAI(callLevelAi, step.ai);

    if (onStepStart) {
      onStepStart({ id, description: step.description });
    }

    // Switch tab before executing the step if requested.
    if (step.switchToTab !== undefined) {
      await tabManager.switchTo(step.switchToTab);
    }

    // Script mode: execute script directly, skip AI and cache
    if (step.isScript) {
      if (!step.script) {
        throw new ValidationError(`Script step ${step.description} has no script content.`);
      }

      logger.debug(`Executing Script Step: ${step.description}`);
      if (step.moduleId) {
        // moduleId is optional metadata used only for logging/debugging to identify the source module of this script step.
        logger.debug(`Module ID: ${step.moduleId}`);
      }

      try {
        let pageScreenshotBeforeApplyingAction = "";

        if (step.waitUntil) {
          pageScreenshotBeforeApplyingAction = (
            await tabManager.active().screenshot({ fullPage: false })
          ).toString("base64");
        }

        if (onReasoning) {
          onReasoning({
            id,
            reasoning: `Executing script for step: ${step.description}`,
          });
        }

        // Execute script securely using AST-based validation
        // This prevents arbitrary code execution by only allowing safe Playwright method chains
        await runSecureScript({
          page: tabManager,
          script: step.script,
          localValues: localValues as Record<string, string>,
          globalValues: globalValues as Record<string, string> | undefined,
          expect, // Pass expect for assertions like expect(locator).toContainText()
        });

        // Handle waitUntil if specified
        if (step.waitUntil) {
          await waitForCondition({
            page: tabManager,
            condition: step.waitUntil,
            pageScreenshotBeforeApplyingAction,
            previousSteps: processedSteps.slice(0, i),
            currentStep: step,
            nextStep: processedSteps[i + 1],
          });
        }

        // Handle data extraction if specified
        // This is done post script execution
        if (step.extract) {
          await applyExtraction({
            extract: step.extract,
            tabManager,
            localValues,
            globalValues,
            executionId,
          });
        }

        if (onStepEnd) {
          onStepEnd({ id, description: step.description });
        }
        continue; // Skip to next step
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Script execution failed: ${message}`);
        errorInStepExecution = message;
        stepThatFailed = step.description;
        break; // Stop execution on script failure
      }
    }

    // CUA mode: use OpenAI Responses API + built-in `computer` tool instead of
    // the ARIA-snapshot path. Coord-based actions aren't cacheable, so we skip
    // the redis cache lookup and the Vercel AI SDK step.
    if (effectiveAi.mode === "cua") {
      logger.debug(`Executing Step (CUA): ${step.description}`);

      let pageScreenshotBeforeApplyingAction = "";
      if (step.waitUntil) {
        pageScreenshotBeforeApplyingAction = (
          await tabManager.active().screenshot({ fullPage: false })
        ).toString("base64");
      }

      try {
        await maybeWithSpan(
          { capability: "step_execution", step: "cua_loop" },
          () =>
            runCUALoop({
              page: tabManager.active(),
              instruction: buildRunStepsPromptCUA({
                auth,
                steps: processedSteps,
                step,
                userFlow,
                stepIndex: i,
              }),
              maxSteps: STEP_EXECUTION_MAX_STEPS,
              abortSignal: AbortSignal.timeout(STEP_EXECUTION_TIMEOUT),
              onReasoning: onReasoning
                ? (reasoning) => onReasoning({ id, reasoning })
                : undefined,
              gateway: effectiveAi.gateway,
            }),
        );
      } catch (error: unknown) {
        logger.error({ err: error }, `CUA step execution failed: ${step.description}`);
        errorInStepExecution = error instanceof Error ? error.message : String(error);
        stepThatFailed = step.description;
        break;
      }

      if (step.waitUntil) {
        await waitForCondition({
          page: tabManager,
          condition: step.waitUntil,
          pageScreenshotBeforeApplyingAction,
          previousSteps: processedSteps.slice(0, i),
          currentStep: step,
          nextStep: processedSteps[i + 1],
        });
      }

      if (step.extract) {
        await applyExtraction({
          extract: step.extract,
          tabManager,
          localValues,
          globalValues,
          executionId,
        });
      }

      if (onStepEnd) {
        onStepEnd({ id, description: step.description });
      }
      continue;
    }

    // First check if the step is cached on redis
    const cachedStep = redis ? await redis.hgetall(`step:${userFlow}:${step.description}`) : {};

    if (
      !bypassCache &&
      !isPlaywrightRetry &&
      !step.bypassCache &&
      cachedStep &&
      Object.keys(cachedStep).length > 0
    ) {
      // Running cached step
      logger.debug(`Executing Cached Step: ${step.description}`);
      const locator = cachedStep["locator"];
      const action = cachedStep["action"] as string;
      const description = (cachedStep["description"] as string).replace(/'/g, "\\'");
      const value = cachedStep["value"];
      const input = step.data?.value || value;

      let code = "";
      switch (action) {
        case "click":
        case "dblclick":
          code = `await page.${locator}.describe('${description}').${action}({ timeout: ${CACHED_ACTION_TIMEOUT} });`;
          break;
        case "fill":
          code = `await page.${locator}.describe('${description}').fill("${input}", { timeout: ${CACHED_ACTION_TIMEOUT} })`;
          break;
        case "hover":
          code = `await page.${locator}.describe('${description}').hover({ timeout: ${CACHED_ACTION_TIMEOUT} })`;
          break;
        case "select-option":
          code = `await page.${locator}.describe('${description}').selectOption("${input}", { timeout: ${CACHED_ACTION_TIMEOUT} })`;
          break;
        case "waitForText":
          code = `await page.getByText("${value}", { exact: true }).first().waitFor({ state: "visible" })`;
          break;
      }

      logger.debug(`Executing cached action:\n${code}`);
      try {
        let pageScreenshotBeforeApplyingAction: string = "";

        if (step.waitUntil) {
          pageScreenshotBeforeApplyingAction = (
            await tabManager.active().screenshot({ fullPage: false })
          ).toString("base64");
        }

        /**
         *  Before executing the first cached step, ensure the DOM is stable to avoid
         *  taking snapshot of a loading or transitioning state. Give it higher idle time because the page might
         *  take a bit longer to stabilize right after navigation.
         */
        const INITIAL_DOM_STABILIZATION_IDLE_TIME = INITIAL_DOM_STABILIZATION_IDLE;
        if (i === 0) {
          await waitForDOMStabilization(tabManager, test, INITIAL_DOM_STABILIZATION_IDLE_TIME);
        }

        const pageSnapshotBeforeApplyingAction = await safeSnapshot(tabManager);
        await runLocatorCode(tabManager, code);

        /**
         *  Verify that the action had the intended effect on the page. This is because sometimes cached pw action may silently fail.
         *
         *  Before verifying, this function will wait for the DOM to stabilize.
         *  stabilization idle time is set to 500ms by default.
         *
         *  This means workflow is this: action performed -> wait for DOM stabilization -> check if action had effect -> next step
         *
         *  Auto healing will be triggered if the action did not have any effect on the page.
         */
        await verifyActionEffect(tabManager, action, pageSnapshotBeforeApplyingAction);

        if (step.waitUntil) {
          await waitForCondition({
            page: tabManager,
            condition: step.waitUntil,
            pageScreenshotBeforeApplyingAction,
            previousSteps: processedSteps.slice(0, i),
            currentStep: step,
            nextStep: processedSteps[i + 1],
          });
        }

        // Handle data extraction if specified
        // This is done post cached step execution
        if (step.extract) {
          await applyExtraction({
            extract: step.extract,
            tabManager,
            localValues,
            globalValues,
            executionId,
          });
        }
        continue;
      } catch (error) {
        logger.debug(`Error executing cached step, falling back to AI execution: ${error}`);
      }
    }

    const abortController = new AbortController();

    const { tools, getPendingCacheData, clearPendingCacheData } = getAItools(tabManager.active(), {
      currentStep: step,
      abortController,
      test,
      tabManager,
    });

    logger.debug(`Executing Step: ${step.description}`);

    let pageScreenshotBeforeApplyingAction: string = "";

    if (step.waitUntil) {
      pageScreenshotBeforeApplyingAction = (await tabManager.active().screenshot({ fullPage: false })).toString(
        "base64",
      );
    }

    const modelId = getModelId("stepExecution");
    const model = resolveModel(modelId);
    logger.debug(
      `Using model: ${modelId} for step execution / gateway: ${getConfig().ai?.gateway ?? "none"}`,
    );

    try {
      const result = await maybeWithSpan(
        { capability: "step_execution", step: "agentic_tool_calling" },
        async () =>
          generateText({
            model,
            maxRetries: MAX_RETRIES,
            temperature: 0,
            tools: tools,
            providerOptions: {
              google: {
                thinkingConfig: {
                  includeThoughts: false,
                  thinkingLevel: "medium",
                },
              },
              openrouter: {
                reasoning: {
                  effort: "medium",
                  exclude: true
                },
              },
            },
            onStepFinish: async ({ toolCalls }) => {
              if (!onReasoning) return;

              // Append tool call reasoning to the response
              toolCalls.forEach((toolCall) => {
                const reasoning = `${(toolCall?.input as { reasoning: string }).reasoning}\n\n`;
                onReasoning({
                  id,
                  reasoning,
                });
              });
            },
            stopWhen: [stepCountIs(STEP_EXECUTION_MAX_STEPS), hasToolCall("browser_stop")],
            abortSignal: AbortSignal.timeout(STEP_EXECUTION_TIMEOUT),
            toolChoice: "auto",
            prompt: buildRunStepsPrompt({
              auth,
              steps: processedSteps,
              step,
              userFlow,
              stepIndex: i,
            }),
          }),
      );

      if (result.usage) {
        await trackUsage(modelId, result.usage);
      }

      // Cache the step action only if it was a single tool call (simple, deterministic action).
      // Multi-step actions are not cached as they may be non-deterministic.
      const allToolCalls = result.steps
        .flatMap((s) => s.toolCalls)
        .filter((tool) => ["browser_snapshot", "browser_stop"].indexOf(tool.toolName) === -1);

      if (allToolCalls.length === 1 && redis) {
        const cacheData = getPendingCacheData();
        if (cacheData) {
          await redis.hset(`step:${userFlow}:${step.description}`, cacheData);
          logger.debug(`Cached step action: ${step.description}`);
        }
      }

      clearPendingCacheData();
    } catch (error: unknown) {
      logger.error({ err: error }, `Step execution failed: ${step.description}`);
      errorInStepExecution = error instanceof Error ? error.message : String(error);
      stepThatFailed = step.description;
      break;
    }

    if (step.waitUntil) {
      await waitForCondition({
        page: tabManager,
        condition: step.waitUntil,
        pageScreenshotBeforeApplyingAction,
        previousSteps: processedSteps.slice(0, i),
        currentStep: step,
        nextStep: processedSteps[i + 1],
      });
    }

    // Handle data extraction if specified
    // This is done post AI step execution
    if (step.extract) {
      await applyExtraction({
        extract: step.extract,
        tabManager,
        localValues,
        globalValues,
        executionId,
      });
    }

    if (onStepEnd) {
      onStepEnd({ id, description: step.description });
    }
  }

  if (errorInStepExecution) {
    logger.warn(`Step execution encountered an error. Skipping assertions execution.`);
    const errorDescription = `\n${errorInStepExecution}\nStep: ${stepThatFailed}`;

    if (test) {
      test.info().annotations.push({
        type: "Error",
        description: errorDescription,
      });
    }

    // Stop & delete the recording before re-throwing so we don't leak a
    // running screencast or a temp file when steps fail mid-flow.
    if (videoRecorder) {
      await videoRecorder.stop();
      await videoRecorder.cleanup();
    }

    throw new StepExecutionError(errorDescription, stepThatFailed);
  }

  // Stop recording (if any) before running assertions so the saved file is
  // ready to upload. Cleanup of the file happens in the finally below.
  if (videoRecorder) {
    await videoRecorder.stop();
  }

  try {
    if (processedAssertions && processedAssertions.length > 0 && expect) {
      for (const {
        assertion: preProcessedAssertion,
        effort,
        images,
        video,
      } of processedAssertions) {
        // Re-resolve placeholders against the latest localValues so extracted
        // values from steps (e.g. {{run.emailContent}}) get substituted in.
        const assertion = replacePlaceholders(
          preProcessedAssertion,
          localValues,
          globalValues,
          projectDataValues,
        );
        logger.info(`Running assertion: ${assertion}`);

        const id = shortid.generate();

        if (onStepStart) {
          onStepStart({
            id,
            description: "Starting assertion verification",
          });
        }

        if (onReasoning) {
          onReasoning({
            id,
            reasoning: `Verifying assertion: ${assertion}`,
          });
        }

        const reasoning = await assert({
          page: tabManager,
          assertion,
          test,
          expect,
          effort,
          images,
          failSilently: failAssertionsSilently,
          maxRetries: 1,
          onRetry: (retryCount, previousResult) => { },
          video: video && Boolean(videoRecorder),
          videoFilePath: videoRecorder?.filePath,
        });

        if (onReasoning) {
          onReasoning({
            id,
            reasoning: `\n\n${reasoning}`,
          });
        }

        if (onStepEnd) {
          onStepEnd({ id, description: "Successfully verified assertion" });
        }
      }
    }
  } finally {
    if (videoRecorder) {
      await videoRecorder.cleanup();
    }
  }
};

/**
 * Runs a complete user flow as a single AI agent call.
 * Best for exploratory testing where exact steps are flexible.
 * The AI autonomously navigates, interacts, and verifies the flow.
 *
 * @param options - User flow configuration
 * @param options.page - The Playwright page instance
 * @param options.userFlow - Description of the user flow to execute
 * @param options.steps - Natural language description of steps to perform
 * @param options.effort - "low" uses a faster model, "high" uses a more capable model with deeper thinking
 * @param options.assertion - Optional assertion to verify after the flow completes
 * @returns The assertion result if an assertion was provided, the raw AI text response otherwise, or undefined on error
 *
 * @example
 * ```typescript
 * const result = await runUserFlow({
 *   page,
 *   userFlow: "Complete a purchase",
 *   steps: "Navigate to store, add an item, checkout",
 *   effort: "high",
 *   assertion: "Order confirmation is displayed",
 * });
 * ```
 */
export const runUserFlow = async ({
  page,
  userFlow,
  steps,
  assertion,
  effort = "low",
  thinkingBudget = THINKING_BUDGET_DEFAULT,
  ai: callLevelAi,
}: UserFlowOptions) => {
  const abortController = new AbortController();
  const effectiveAi = resolveAI(callLevelAi);

  // CUA mode: skip the Vercel AI SDK path entirely. Run the Responses API loop,
  // then reuse the existing utility-model assertion parser on its final text.
  if (effectiveAi.mode === "cua") {
    try {
      const text = await maybeWithSpan(
        { capability: "user_flow_execution", step: "cua_loop" },
        () =>
          runCUALoop({
            page,
            instruction: buildRunUserFlowPromptCUA({ userFlow, steps, assertion }),
            maxSteps: USER_FLOW_MAX_STEPS,
            abortSignal: abortController.signal,
            gateway: effectiveAi.gateway,
          }),
      );

      if (assertion) {
        const utilityModelId = getModelId("utility");
        const { output, usage } = await generateText({
          model: resolveModel(utilityModelId),
          prompt: `Convert the following text output into a valid JSON object with the specified properties:\n\n${text}`,
          output: Output.object({
            schema: z.object({
              assertionPassed: z.boolean().describe("Indicates whether the assertion passed or not."),
              confidenceScore: z
                .number()
                .describe("Confidence score of the assertion, between 0 and 100."),
              reasoning: z
                .string()
                .describe("Brief explanation of the reasoning behind the assertion."),
            }),
          }),
        });
        
        if (usage) {
          await trackUsage(utilityModelId, usage);
        }

        return output;
      }

      return text;
    } catch (error: unknown) {
      logger.error({ err: error }, "Error during CUA user flow execution");
      return;
    }
  }

  const model =
    effort === "low"
      ? resolveModel(effectiveAi.getModelId("userFlowLow"), effectiveAi.gateway)
      : resolveModel(effectiveAi.getModelId("userFlowHigh"), effectiveAi.gateway);

  const { tools } = getAItools(page, {
    abortController,
  });

  try {
    const result = await maybeWithSpan(
      { capability: "user_flow_execution", step: "agentic_tool_calling" },
      async () => {
        return generateText({
          model,
          maxRetries: MAX_RETRIES,
          temperature: 0,
          tools: tools,
          providerOptions: {
            google: {
              thinkingConfig: {
                thinkingBudget,
              },
            },
            openrouter: {
              reasoning: {
                max_tokens: thinkingBudget,
              },
            },
          },
          stopWhen: [stepCountIs(USER_FLOW_MAX_STEPS), hasToolCall("browser_stop")],
          abortSignal: abortController.signal,
          prepareStep: async ({ messages }) => {
            // Remove older messages to keep the context window small
            if (messages.length > 11) {
              const modifiedMessages = [messages[0], ...messages.slice(-10)];
              return {
                messages: modifiedMessages,
              };
            }

            return {};
          },
          toolChoice: "auto",
          prompt: buildRunUserFlowPrompt({
            steps,
            userFlow,
            assertion,
          }),
        });
      },
    );

    if (result.usage) {
      await trackUsage(
        effort === "low" ? getModelId("userFlowLow") : getModelId("userFlowHigh"),
        result.usage,
      );
    }

    if (assertion) {
      const utilityModelId = getModelId("utility");
      const { output, usage } = await generateText({
        model: resolveModel(utilityModelId),
        prompt: `Convert the following text output into a valid JSON object with the specified properties:\n\n${result.text}`,
        output: Output.object({
          schema: z.object({
            assertionPassed: z.boolean().describe("Indicates whether the assertion passed or not."),
            confidenceScore: z
              .number()
              .describe("Confidence score of the assertion, between 0 and 100."),
            reasoning: z
              .string()
              .describe("Brief explanation of the reasoning behind the assertion."),
          }),
        }),
      });

      if (usage) {
        await trackUsage(utilityModelId, usage);
      }

      return output;
    }

    return result.text;
  } catch (error: unknown) {
    logger.error({ err: error }, "Error during user flow execution");
  }
};

/**
 * Wraps a cached Playwright flow with AI fallback for auto-healing.
 * Tries the cached flow first; if it fails (e.g., due to UI changes), falls back to AI execution.
 *
 * @param config - Configuration for cached and AI flow execution
 * @param config.cachedFlow - The cached Playwright flow to try first
 * @param config.aiFlow - The AI-powered fallback flow to run if cached flow fails
 * @param config.aiFlowTimeout - Optional timeout for the AI flow in milliseconds
 * @param config.test - Playwright test instance for retry detection and timeout management
 *
 * @example
 * ```typescript
 * await executeWithAutoHealing({
 *   cachedFlow: async () => { await page.getByRole("button").click(); },
 *   aiFlow: async () => { await runSteps({ page, userFlow: "Click submit", steps }); },
 *   test,
 * });
 * ```
 */
export const executeWithAutoHealing = async (config: {
  cachedFlow: () => Promise<void>;
  aiFlow: () => Promise<void>;
  aiFlowTimeout?: number;
  test: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
}) => {
  const { cachedFlow, aiFlow, test, aiFlowTimeout } = config;

  if (process.env.AI || test.info().retry > 0) {
    if (aiFlowTimeout) {
      test.setTimeout(aiFlowTimeout);
    }
    await aiFlow();
  } else {
    await cachedFlow();
  }
};

export { configure } from "./config";
export type { EmailProvider } from "./config";
export { emailsinkProvider } from "./providers/emailsink";

export { extractEmailContent, generateEmail } from "./email";

export { assert } from "./assertion";

export type { AssertionResult } from "./types";
export { PassmarkError, StepExecutionError, ValidationError, AIModelError, CacheError, ConfigurationError } from "./errors";
