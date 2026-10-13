import { describe, it, expect } from "vitest";
import {
  PassmarkError,
  StepExecutionError,
  AIModelError,
  CacheError,
  ConfigurationError,
  ValidationError,
} from "../errors";

describe("Custom Errors", () => {
  it("PassmarkError creates correct properties", () => {
    const err = new PassmarkError("base error", "BASE_CODE");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PassmarkError");
    expect(err.message).toBe("base error");
    expect(err.code).toBe("BASE_CODE");
  });

  it("StepExecutionError creates correct properties", () => {
    const err = new StepExecutionError("step failed", "my step");
    expect(err).toBeInstanceOf(PassmarkError);
    expect(err.name).toBe("StepExecutionError");
    expect(err.message).toBe("step failed");
    expect(err.code).toBe("STEP_EXECUTION_FAILED");
    expect(err.stepDescription).toBe("my step");
  });

  it("AIModelError creates correct properties", () => {
    const err = new AIModelError("ai failed");
    expect(err).toBeInstanceOf(PassmarkError);
    expect(err.name).toBe("AIModelError");
    expect(err.message).toBe("ai failed");
    expect(err.code).toBe("AI_MODEL_ERROR");
  });

  it("CacheError creates correct properties", () => {
    const err = new CacheError("cache miss");
    expect(err).toBeInstanceOf(PassmarkError);
    expect(err.name).toBe("CacheError");
    expect(err.message).toBe("cache miss");
    expect(err.code).toBe("CACHE_ERROR");
  });

  it("ConfigurationError creates correct properties", () => {
    const err = new ConfigurationError("missing key");
    expect(err).toBeInstanceOf(PassmarkError);
    expect(err.name).toBe("ConfigurationError");
    expect(err.message).toBe("missing key");
    expect(err.code).toBe("CONFIGURATION_ERROR");
  });

  it("ValidationError creates correct properties", () => {
    const err = new ValidationError("invalid input");
    expect(err).toBeInstanceOf(PassmarkError);
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("invalid input");
    expect(err.code).toBe("VALIDATION_ERROR");
  });
});
