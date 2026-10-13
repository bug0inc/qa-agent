import { LanguageModel } from "ai";
import {
  Expect,
  type Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "@playwright/test";
import type { AIOverride } from "./config";
import type { TabManager } from "./utils/tab-manager";

export type PageInput = Page | TabManager;

export type AssertionResult = {
  assertionPassed: boolean;
  confidenceScore: number; // Between 0 and 100
  reasoning: string; // Brief explanation of the reasoning behind the assertion
};

export type AuthConfig = {
  email: string;
  password: string;
  callbackUrl?: string;
};

export type UserFlowOptions = {
  page: Page;
  userFlow: string;
  steps: string;

  // optional fields
  assertion?: string;
  effort?: "low" | "high";
  thinkingBudget?: number; // in tokens, default 1024
  auth?: AuthConfig;
  model?: LanguageModel;
  /**
   * Override the AI mode/gateway/models for this user-flow run only.
   * Falls back to the global `configure()` values when omitted.
   */
  ai?: AIOverride;
};

/**
 * Configuration for extracting data from a page using AI.
 * The extracted value will be stored under the chosen scope and can be used in subsequent steps.
 */
export type ExtractionConfig = {
  /** Key name - the extracted value will be accessible as {{run.keyName}} (local scope) or {{global.keyName}} (global scope) in subsequent steps' data.value */
  as: string;
  /** Prompt describing what to extract from the page/URL */
  prompt: string;
  /**
   * Where to store the extracted value.
   * - "local" (default): stored as {{run.as}}, available only within the current runSteps call.
   * - "global": stored as {{global.as}} and persisted to Redis under the runSteps `executionId`,
   *   so subsequent runSteps calls with the same executionId can read it. Requires `executionId`.
   */
  scope?: "local" | "global";
};

export type Step = {
  bypassCache?: boolean;
  description: string;
  data?: Record<string, string>;
  waitUntil?: string;
  isScript?: boolean;
  script?: string;
  moduleId?: string;
  /** Extract data from page/URL using AI and store as {{run.as}} (local) or {{global.as}} (global) for later use */
  extract?: ExtractionConfig;
  /** Switch the active page before this step runs. 'main' = original tab, 'latest' = most recently opened, or numeric index. */
  switchToTab?: "main" | "latest" | number;
  /**
   * Override the AI mode/gateway/models for just this step. Lets you mix
   * snapshot and CUA steps in the same `runSteps` call. Beats both the
   * `runSteps` call-level `ai` and the global `configure()` value.
   */
  ai?: AIOverride;
};

export type AssertionOptions = {
  page: PageInput;
  assertion: string;
  failSilently?: boolean;
  test?: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
  expect: Expect<{}>;
  effort?: "low" | "high";
  images?: string[];
  maxRetries?: number;
  onRetry?: (retryCount: number, previousResult: AssertionResult) => void;
  /**
   * When true, `runSteps` records a video across the step run and feeds it
   * to a video-capable Gemini model for assertion. Useful for ephemeral UI
   * (toasts, banners) that a single screenshot may miss. Standalone `assert`
   * callers can also pass `videoFilePath` directly.
   */
  video?: boolean;
  /**
   * Absolute path to a pre-recorded video file (.webm/.mp4) for the
   * assertion to evaluate. Set by `runSteps` when `video: true`; can also be
   * supplied by callers who record their own video.
   */
  videoFilePath?: string;
};

export type WaitConditionResult = {
  conditionMet: boolean;
  reasoning: string;
};

export type WaitForConditionOptions = {
  page: PageInput;
  condition: string;
  pageScreenshotBeforeApplyingAction: string;
  previousSteps?: Step[];
  currentStep: Step;
  nextStep?: Step;
  initialInterval?: number; // Initial wait interval in ms which will be increased exponentially
  timeout?: number; // We'll stop trying after this time
  maxInterval?: number; // Maximum wait interval in ms
};

export type RunStepsOptions = {
  projectId?: string;
  page: Page;
  test?: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
  userFlow: string;
  steps: Step[];

  // optional fields
  bypassCache?: boolean;
  failAssertionsSilently?: boolean;
  auth?: AuthConfig;
  onStepStart?: (step: { id: string; description: string }) => void;
  onStepEnd?: (step: { id: string; description: string }) => void;
  onReasoning?: (step: { id: string; reasoning: string }) => void;

  /**
   * Execution ID to link multiple runSteps calls together.
   * When provided, {{global.*}} placeholders are persisted to Redis
   * and shared across all runSteps calls with the same executionId.
   * Required when using {{global.*}} placeholders.
   */
  executionId?: string;
  /**
   * Default AI override applied to every step in this call. Individual
   * `step.ai` overrides take precedence over this; this takes precedence
   * over the global `configure()` value.
   */
  ai?: AIOverride;
} & (
    | {
      assertions: Omit<AssertionOptions, "page" | "test" | "expect">[];
      expect: Expect<{}>;
    }
    | { assertions?: never; expect?: never }
  );

export type VisualExplanationResult = {
  explanation: string;
  isBug: boolean;
  confidence: number;
  diffAreas?: string[];
};

export type VisualDiffOptions = {
  page: Page;
  expectedImage?: string | Buffer;
  actualImage?: string | Buffer;
  test?: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
};
