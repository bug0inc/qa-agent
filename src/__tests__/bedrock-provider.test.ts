import { describe, it, expect, beforeEach } from "vitest";
import { configure, resetConfig } from "../config";
import { resolveModel } from "../models";

describe("Bedrock provider", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("throws helpful error when AWS_REGION is not set", () => {
    const originalRegion = process.env.AWS_REGION;
    delete process.env.AWS_REGION;

    expect(() => resolveModel("bedrock/claude-3-5-sonnet")).toThrow(
      /AWS_REGION isn't set/,
    );

    if (originalRegion) {
      process.env.AWS_REGION = originalRegion;
    }
  });

  it("can load Bedrock provider dynamically", () => {
    // This test verifies that the dynamic require() of the ESM-only
    // @ai-sdk/amazon-bedrock package works in the current Node.js environment
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "test-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

    // This should not throw - we're just testing that the module loads
    // We expect this to succeed because the dynamic require() should work
    expect(() => resolveModel("bedrock/claude-3-5-sonnet")).not.toThrow(
      /Failed to load AWS Bedrock provider/,
    );
  });

  it("resolves Bedrock model aliases correctly", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "test-key";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

    // These should all resolve without throwing
    expect(() => resolveModel("bedrock/claude-3-5-sonnet")).not.toThrow();
    expect(() => resolveModel("bedrock/claude-3-5-haiku")).not.toThrow();
    expect(() => resolveModel("bedrock/claude-3-opus")).not.toThrow();

    // Full model IDs should also work
    expect(() =>
      resolveModel("bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).not.toThrow();
  });

  it("throws error when using Bedrock with Cloudflare gateway", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
    process.env.CLOUDFLARE_AI_GATEWAY = "test-gateway";

    configure({
      ai: {
        gateway: "cloudflare",
      },
    });

    expect(() => resolveModel("bedrock/claude-3-5-sonnet")).toThrow(
      /Cloudflare AI Gateway routing is not supported for AWS Bedrock/,
    );
  });
});
