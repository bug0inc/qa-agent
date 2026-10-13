/**
 * errors.ts
 *
 * Custom error hierarchy for Passmark.
 * All Passmark errors extend PassmarkError so callers can distinguish
 * framework errors from generic runtime errors with a simple instanceof check.
 *
 * Usage:
 *   import { StepExecutionError, AIModelError } from "./errors";
 *
 *   try { ... }
 *   catch (e) {
 *     if (e instanceof StepExecutionError) { ... }
 *   }
 */

// ─── Base ─────────────────────────────────────────────────────────────────

export class PassmarkError extends Error {
  /** Machine-readable error code, stable across versions. */
  public readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    // Maintains proper stack trace in V8 (Node.js / Chrome)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ─── Subclasses ───────────────────────────────────────────────────────────

/**
 * Thrown when a test step fails during AI or cached execution.
 *
 * Replaces: throw new Error(errorDescription) in index.ts
 */
export class StepExecutionError extends PassmarkError {
  public readonly stepDescription: string;

  constructor(message: string, stepDescription: string) {
    super(message, "STEP_EXECUTION_FAILED");
    this.stepDescription = stepDescription;
  }
}

/**
 * Thrown when an AI model call fails or the provider is misconfigured.
 *
 * Replaces: throw new Error(`Unknown AI provider: ${provider}`) in models.ts
 */
export class AIModelError extends PassmarkError {
  constructor(message: string) {
    super(message, "AI_MODEL_ERROR");
  }
}

/**
 * Thrown when a Redis operation fails or cache is unavailable.
 *
 * For future use as Redis error handling gets more granular.
 */
export class CacheError extends PassmarkError {
  constructor(message: string) {
    super(message, "CACHE_ERROR");
  }
}

/**
 * Thrown when required environment variables or configuration are missing.
 *
 * Replaces: throw new Error("GOOGLE_GENERATIVE_AI_API_KEY isn't set...") in models.ts
 */
export class ConfigurationError extends PassmarkError {
  constructor(message: string) {
    super(message, "CONFIGURATION_ERROR");
  }
}

/**
 * Thrown when input fails validation (e.g. a script step has no script).
 *
 * Replaces: throw new Error(`Script step ${step.description} has no script content.`)
 */
export class ValidationError extends PassmarkError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR");
  }
}

/**
 * Thrown when visual regression explanation fails.
 */
export class VisualRegressionError extends PassmarkError {
  constructor(message: string) {
    super(message, "VISUAL_REGRESSION_ERROR");
  }
}