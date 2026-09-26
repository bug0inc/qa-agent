import { ConfigurationError, ValidationError } from "./errors";
import shortid from "shortid";
import { getConfig } from "./config";
import { extractEmailContent } from "./email";
import { GLOBAL_VALUES_TTL_SECONDS } from "./constants";
import { logger } from "./logger";
import { getRedis } from "./redis";
import { Step } from "./types";
import { generatePhoneNumber } from "./utils";

// =============================================================================
// Types
// =============================================================================

/**
 * Local placeholders that are fresh for each runSteps call.
 * These values are NOT persisted and are regenerated every time.
 */
export type LocalPlaceholders = {
  "{{run.shortid}}": string;
  "{{run.fullName}}": string;
  "{{run.email}}": string;
  "{{run.dynamicEmail}}": string;
  "{{run.phoneNumber}}": string;
} & {
  // Values extracted at runtime via `extract` with scope "local" are stored as {{run.<as>}}.
  [key: string]: string;
};

/**
 * Global placeholders that are shared across all tests within an execution.
 * These values are persisted to Redis and loaded for subsequent runSteps calls
 * with the same executionId.
 */
export type GlobalPlaceholders = {
  "{{global.shortid}}": string;
  "{{global.fullName}}": string;
  "{{global.email}}": string;
  "{{global.dynamicEmail}}": string;
  "{{global.phoneNumber}}": string;
} & {
  // Values extracted at runtime via `extract` with scope "global" are stored as {{global.<as>}}.
  [key: string]: string;
};

/**
 * Project data placeholders for {{data.key}} syntax.
 * These are stored in Redis and managed via project settings.
 */
export type ProjectDataPlaceholders = Record<string, string>;

export type AssertionItem = {
  assertion: string;
  effort?: "low" | "high";
  images?: string[];
  /**
   * When true, `runSteps` records a video while executing the surrounding
   * steps and passes it to the assertion for evaluation. Useful for
   * ephemeral UI like toasts that a screenshot may miss.
   */
  video?: boolean;
};

export type ProcessPlaceholdersResult = {
  processedSteps: Step[];
  processedAssertions?: AssertionItem[];
  localValues: LocalPlaceholders;
  globalValues?: GlobalPlaceholders;
  projectDataValues?: ProjectDataPlaceholders;
  hasGlobalPlaceholders: boolean;
};

// =============================================================================
// Constants
// =============================================================================

/**
 * Pattern to match email extraction placeholders.
 * Format: {{email.<type>:<prompt>}} or {{email.<type>:<prompt>:<email>}}
 * Examples:
 *   - {{email.otp:get the 6 digit verification code}}
 *   - {{email.otp:get the 6 digit verification code:sandeep@bug0.ai}}
 *   - {{email.link:get the magic link url}}
 *   - {{email.code:get the confirmation code}}
 */
export const EMAIL_EXTRACTION_PATTERN = /\{\{email\.(\w+):([^:}]+)(?::([^}]+))?\}\}/;

export const LOCAL_PLACEHOLDER_KEYS: (keyof LocalPlaceholders)[] = [
  "{{run.shortid}}",
  "{{run.fullName}}",
  "{{run.email}}",
  "{{run.dynamicEmail}}",
  "{{run.phoneNumber}}",
];

export const GLOBAL_PLACEHOLDER_KEYS: (keyof GlobalPlaceholders)[] = [
  "{{global.shortid}}",
  "{{global.fullName}}",
  "{{global.email}}",
  "{{global.dynamicEmail}}",
  "{{global.phoneNumber}}",
];

/** Pattern to detect any global placeholder in text */
const GLOBAL_PLACEHOLDER_PATTERN = /\{\{global\.\w+\}\}/;

/** Pattern to detect any project data placeholder in text */
const PROJECT_DATA_PLACEHOLDER_PATTERN = /\{\{data\.(\w+)\}\}/g;

// =============================================================================
// Redis Operations (Global Values)
// =============================================================================

/**
 * Generates a Redis key for storing global values for an execution.
 */
function getRedisKey(executionId: string): string {
  return `execution:${executionId}:globals`;
}

/**
 * Fetches global values from Redis for a given execution ID.
 * Returns null if no values exist.
 */
export async function getGlobalValues(
  executionId: string,
): Promise<Partial<GlobalPlaceholders> | null> {
  const redis = getRedis();
  if (!redis) return null;
  const key = getRedisKey(executionId);
  const values = await redis.hgetall(key);

  if (!values || Object.keys(values).length === 0) {
    return null;
  }

  return values as Partial<GlobalPlaceholders>;
}

/**
 * Saves global values to Redis for a given execution ID.
 * Sets a 24-hour TTL on the key.
 */
export async function saveGlobalValues(
  executionId: string,
  values: GlobalPlaceholders,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;

  const key = getRedisKey(executionId);

  // Save all values as a hash
  await redis.hset(key, values);

  // Set TTL
  await redis.expire(key, GLOBAL_VALUES_TTL_SECONDS);

  logger.debug(`Saved global values to Redis for execution: ${executionId}`);
}

// =============================================================================
// Redis Operations (Project Data)
// =============================================================================

/**
 * Generates a Redis key for storing project data.
 */
function getProjectDataRedisKey(projectId: string): string {
  return `project:${projectId}:data`;
}

/**
 * Fetches project data from Redis for a given project ID.
 * Returns an empty object if no data exists.
 */
export async function getProjectData(projectId: string): Promise<ProjectDataPlaceholders> {
  const redis = getRedis();
  if (!redis) return {};
  const key = getProjectDataRedisKey(projectId);
  const values = await redis.hgetall(key);

  if (!values || Object.keys(values).length === 0) {
    return {};
  }

  return values as ProjectDataPlaceholders;
}

// =============================================================================
// Value Generation
// =============================================================================

/**
 * Generates local values for placeholders.
 * These are fresh for each runSteps call.
 */
export async function generateLocalValues(): Promise<LocalPlaceholders> {
  const { faker } = await import("@faker-js/faker");
  const { v4: uuidv4 } = await import("uuid");
  const emailDomain = getConfig().email?.domain;

  return {
    "{{run.shortid}}": shortid.generate(),
    "{{run.fullName}}": faker.person.fullName(),
    "{{run.email}}": faker.internet.email(),
    "{{run.dynamicEmail}}": emailDomain ? `e2e-tester-${uuidv4()}@${emailDomain}` : "",
    "{{run.phoneNumber}}": generatePhoneNumber(),
  };
}

/**
 * Generates global values, reusing any existing values provided.
 * Only generates values for keys that don't exist in existingValues.
 */
export async function generateGlobalValues(
  existingValues: Partial<GlobalPlaceholders> | null,
): Promise<GlobalPlaceholders> {
  const { faker } = await import("@faker-js/faker");
  const { v4: uuidv4 } = await import("uuid");
  const emailDomain = getConfig().email?.domain;

  return {
    // Preserve any runtime-extracted {{global.<as>}} values so they survive across runSteps calls.
    ...(existingValues ?? {}),
    "{{global.shortid}}": existingValues?.["{{global.shortid}}"] ?? shortid.generate(),
    "{{global.fullName}}": existingValues?.["{{global.fullName}}"] ?? faker.person.fullName(),
    "{{global.email}}": existingValues?.["{{global.email}}"] ?? faker.internet.email(),
    "{{global.dynamicEmail}}":
      existingValues?.["{{global.dynamicEmail}}"] ??
      (emailDomain ? `e2e-tester-${uuidv4()}@${emailDomain}` : ""),
    "{{global.phoneNumber}}": existingValues?.["{{global.phoneNumber}}"] ?? generatePhoneNumber(),
  };
}

// =============================================================================
// Placeholder Detection
// =============================================================================

/**
 * Checks if any text contains global placeholders.
 */
export function containsGlobalPlaceholder(text: string): boolean {
  return GLOBAL_PLACEHOLDER_PATTERN.test(text);
}

/**
 * Scans steps for any global placeholders.
 * Returns true if any step description, data value, or script contains a global placeholder.
 */
export function stepsContainGlobalPlaceholders(
  steps: {
    description: string;
    data?: Record<string, string>;
    script?: string;
    waitUntil?: string;
  }[],
): boolean {
  for (const step of steps) {
    if (containsGlobalPlaceholder(step.description)) {
      return true;
    }

    if (step.data) {
      for (const value of Object.values(step.data)) {
        if (containsGlobalPlaceholder(value)) {
          return true;
        }
      }
    }

    if (step.script && containsGlobalPlaceholder(step.script)) {
      return true;
    }

    if (step.waitUntil && containsGlobalPlaceholder(step.waitUntil)) {
      return true;
    }
  }

  return false;
}

/**
 * Scans assertions for any global placeholders.
 */
export function assertionsContainGlobalPlaceholders(assertions?: { assertion: string }[]): boolean {
  if (!assertions) return false;

  for (const item of assertions) {
    if (containsGlobalPlaceholder(item.assertion)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if any text contains project data placeholders.
 */
export function containsProjectDataPlaceholder(text: string): boolean {
  // Reset lastIndex since we're using a global regex
  PROJECT_DATA_PLACEHOLDER_PATTERN.lastIndex = 0;
  return PROJECT_DATA_PLACEHOLDER_PATTERN.test(text);
}

/**
 * Scans steps for any project data placeholders.
 * Returns true if any step description, data value, or script contains a project data placeholder.
 */
export function stepsContainProjectDataPlaceholders(
  steps: {
    description: string;
    data?: Record<string, string>;
    script?: string;
    waitUntil?: string;
  }[],
): boolean {
  for (const step of steps) {
    if (containsProjectDataPlaceholder(step.description)) {
      return true;
    }

    if (step.data) {
      for (const value of Object.values(step.data)) {
        if (containsProjectDataPlaceholder(value)) {
          return true;
        }
      }
    }

    if (step.script && containsProjectDataPlaceholder(step.script)) {
      return true;
    }

    if (step.waitUntil && containsProjectDataPlaceholder(step.waitUntil)) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Placeholder Replacement
// =============================================================================

/**
 * Replaces dynamic placeholders in a string with their corresponding values.
 * Handles {{run.*}}, {{global.*}}, and {{data.*}} placeholders.
 */
export function replacePlaceholders(
  text: string,
  localValues: LocalPlaceholders,
  globalValues?: GlobalPlaceholders,
  projectDataValues?: ProjectDataPlaceholders,
): string {
  let result = text;

  // Throw if dynamicEmail placeholders are used without an email provider configured
  const dynamicEmailPlaceholders = ["{{run.dynamicEmail}}", "{{global.dynamicEmail}}"];
  for (const placeholder of dynamicEmailPlaceholders) {
    if (result.includes(placeholder) && !getConfig().email) {
      throw new ConfigurationError(
        `Email provider not configured. Call configure({ email: ... }) before using ${placeholder}.`,
      );
    }
  }

  // Replace {{run.*}} placeholders
  for (const [placeholder, value] of Object.entries(localValues)) {
    result = result.split(placeholder).join(value);
  }

  // Replace {{global.*}} placeholders
  if (globalValues) {
    for (const [placeholder, value] of Object.entries(globalValues)) {
      result = result.split(placeholder).join(value);
    }
  }

  // Replace {{data.key}} placeholders
  if (projectDataValues) {
    result = result.replace(/\{\{data\.(\w+)\}\}/g, (match, key) => {
      const value = projectDataValues[key];
      if (value === undefined) {
        logger.warn(`[ProjectData] Placeholder ${match} not found`);
        return match;
      }
      return value;
    });
  }

  return result;
}

// =============================================================================
// Main Processing Function
// =============================================================================

/**
 * Processes steps and assertions to replace dynamic placeholders with consistent values.
 * Handles {{run.*}} placeholders (fresh per call), {{global.*}} placeholders
 * (shared across execution via Redis), and {{data.*}} placeholders (project data from Redis).
 * Returns the processed steps and assertions along with the generated values.
 */
export async function processPlaceholders(
  steps: Step[],
  assertions?: AssertionItem[],
  executionId?: string,
  projectId?: string,
): Promise<ProcessPlaceholdersResult> {
  // Check if global placeholders are used without executionId
  const hasGlobalPlaceholders =
    stepsContainGlobalPlaceholders(steps) || assertionsContainGlobalPlaceholders(assertions);

  if (hasGlobalPlaceholders && !executionId) {
    throw new ValidationError(
      "{{global.*}} placeholders require an executionId. " +
        "Please provide executionId in runSteps options to use global placeholders.",
    );
  }

  // Check if any step extracts into the global scope without an executionId
  const hasGlobalExtract = steps.some((step) => step.extract?.scope === "global");

  if (hasGlobalExtract && !executionId) {
    throw new ValidationError(
      'extract with scope "global" requires an executionId. ' +
      "Please provide executionId in runSteps options to extract values into the global scope.",
    );
  }

  // Check if project data placeholders are used without projectId
  const hasProjectDataPlaceholders = stepsContainProjectDataPlaceholders(steps);

  if (hasProjectDataPlaceholders && !projectId) {
    throw new ValidationError(
      "{{data.*}} placeholders require a projectId. " +
        "Please provide projectId in runSteps options to use project data placeholders.",
    );
  }

  // Generate fresh run values (always new per runSteps call)
  const localValues = await generateLocalValues();

  // Handle global values if executionId is provided
  let globalValues: GlobalPlaceholders | undefined;
  if (executionId) {
    // Try to load existing global values from Redis
    const existingGlobalValues = await getGlobalValues(executionId);

    // Generate global values, reusing existing ones
    globalValues = await generateGlobalValues(existingGlobalValues);

    // Save global values back to Redis (updates TTL and adds any new values)
    await saveGlobalValues(executionId, globalValues);

    logger.debug({ globalValues }, `Using global values for execution ${executionId}`);
  }

  // Fetch project data if projectId is provided
  let projectDataValues: ProjectDataPlaceholders | undefined;
  if (projectId) {
    projectDataValues = await getProjectData(projectId);
    logger.debug({ projectDataValues }, `Using project data for project ${projectId}`);
  }

  // Deep clone and process steps
  // Note: Email extraction placeholders ({{email.xxx:prompt}}) are NOT resolved here.
  // They are resolved lazily in runSteps just before each step executes.
  const processedSteps = steps.map((step) => {
    const processedStep = { ...step };

    if (processedStep.data) {
      processedStep.data = { ...processedStep.data };
      for (const key in processedStep.data) {
        processedStep.data[key] = replacePlaceholders(
          processedStep.data[key],
          localValues,
          globalValues,
          projectDataValues,
        );
      }
    }

    // Process script placeholders if present
    if (processedStep.script) {
      processedStep.script = replacePlaceholders(
        processedStep.script,
        localValues,
        globalValues,
        projectDataValues,
      );
    }

    // Process waitUntil placeholders if present
    if (processedStep.waitUntil) {
      processedStep.waitUntil = replacePlaceholders(
        processedStep.waitUntil,
        localValues,
        globalValues,
        projectDataValues,
      );
    }

    return processedStep;
  });

  // Process assertions if provided
  let processedAssertions: AssertionItem[] | undefined;
  if (assertions) {
    processedAssertions = assertions.map((assertionItem) => ({
      ...assertionItem,
      assertion: replacePlaceholders(
        assertionItem.assertion,
        localValues,
        globalValues,
        projectDataValues,
      ),
    }));
  }

  return {
    processedSteps,
    processedAssertions,
    localValues,
    globalValues,
    projectDataValues,
    hasGlobalPlaceholders,
  };
}

/**
 * Gets the dynamic email to use for email extraction.
 * Only prefers global email when preferGlobal is true (i.e. the current step
 * set actually references {{global.*}} placeholders). Otherwise always returns
 * the run-scoped email so all steps in the current runSteps call share a run scoped email.
 */
export function getDynamicEmail(
  localValues: LocalPlaceholders,
  globalValues?: GlobalPlaceholders,
  preferGlobal = false,
): string {
  if (preferGlobal && globalValues?.["{{global.dynamicEmail}}"]) {
    return globalValues["{{global.dynamicEmail}}"];
  }
  return localValues["{{run.dynamicEmail}}"];
}

/**
 * Resolves email extraction placeholders in step data.
 * This should be called just before step execution to ensure emails have arrived.
 */
export async function resolveEmailPlaceholders(step: Step, dynamicEmail: string): Promise<Step> {
  if (!step.data) return step;

  const resolvedData: Record<string, string> = { ...step.data };
  let hasEmailExtraction = false;

  for (const key in resolvedData) {
    const value = resolvedData[key];
    const match = value.match(EMAIL_EXTRACTION_PATTERN);

    if (match) {
      hasEmailExtraction = true;
      const [fullMatch, extractType, prompt, explicitEmail] = match;
      const targetEmail = explicitEmail?.trim() || dynamicEmail;

      logger.debug(`Extracting ${extractType} from ${targetEmail} with prompt: "${prompt}"`);

      const extractedValue = await extractEmailContent({
        email: targetEmail,
        prompt: prompt.trim(),
      });

      resolvedData[key] = value.replace(fullMatch, extractedValue);
    }
  }

  if (hasEmailExtraction) {
    return { ...step, data: resolvedData };
  }

  return step;
}
