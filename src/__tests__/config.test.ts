import { describe, it, expect, beforeEach } from "vitest";
import { configure, getConfig, getModelId, resetConfig, DEFAULT_MODELS } from "../config";

describe("config", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("getConfig returns empty object by default", () => {
    expect(getConfig()).toEqual({});
  });

  it("configure sets email provider", () => {
    const email = {
      domain: "example.com",
      extractContent: async () => "content",
    };
    configure({ email });
    expect(getConfig().email).toEqual(email);
  });

  it("configure sets ai.gateway to vercel", () => {
    configure({ ai: { gateway: "vercel" } });
    expect(getConfig().ai?.gateway).toBe("vercel");
  });

  it("configure sets ai.gateway to openrouter", () => {
    configure({ ai: { gateway: "openrouter" } });
    expect(getConfig().ai?.gateway).toBe("openrouter");
  });

  it("configure sets ai.gateway to opencodezen", () => {
    configure({ ai: { gateway: "opencodezen" } });
    expect(getConfig().ai?.gateway).toBe("opencodezen");
  });

  it("configure merges without overwriting other keys", () => {
    configure({ uploadBasePath: "./uploads" });
    configure({ ai: { gateway: "none" } });

    const config = getConfig();
    expect(config.uploadBasePath).toBe("./uploads");
    expect(config.ai?.gateway).toBe("none");
  });

  it("configure overwrites same key", () => {
    configure({ uploadBasePath: "./first" });
    configure({ uploadBasePath: "./second" });
    expect(getConfig().uploadBasePath).toBe("./second");
  });

  it("getModelId returns default for each of the keys", () => {
    const keys = Object.keys(DEFAULT_MODELS) as Array<keyof typeof DEFAULT_MODELS>;
    expect(keys).toHaveLength(9);

    for (const key of keys) {
      // assertionModels is a special case—it's not a simple string ID like the others
      if (key === "assertionModels") {
        expect(DEFAULT_MODELS[key]).toBeUndefined();
        continue;
      }
      expect(getModelId(key)).toBe(DEFAULT_MODELS[key]);
    }
  });

  it("getModelId returns custom value after configure", () => {
    configure({
      ai: { models: { stepExecution: "custom/my-model" } },
    });
    expect(getModelId("stepExecution")).toBe("custom/my-model");
  });

  it("getModelId falls back to default for unconfigured keys", () => {
    configure({
      ai: { models: { stepExecution: "custom/my-model" } },
    });
    // Other keys should still return their defaults
    expect(getModelId("utility")).toBe(DEFAULT_MODELS.utility);
  });

  it("configure with uploadBasePath", () => {
    configure({ uploadBasePath: "/tmp/test-uploads" });
    expect(getConfig().uploadBasePath).toBe("/tmp/test-uploads");
  });

  it("resetConfig clears everything", () => {
    configure({
      uploadBasePath: "./uploads",
      ai: { gateway: "vercel", models: { utility: "custom/model" } },
      email: {
        domain: "test.dev",
        extractContent: async () => "value",
      },
    });

    // Verify config is populated
    expect(getConfig().uploadBasePath).toBeDefined();
    expect(getConfig().ai).toBeDefined();
    expect(getConfig().email).toBeDefined();

    resetConfig();
    expect(getConfig()).toEqual({});
  });
});
