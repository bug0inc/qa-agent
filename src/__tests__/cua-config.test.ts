import { describe, it, expect, beforeEach } from "vitest";
import { configure, getMode, getModelId, resetConfig, resolveAI, DEFAULT_MODELS } from "../config";

describe("cua config", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("getMode defaults to snapshot", () => {
    expect(getMode()).toBe("snapshot");
  });

  it("configure sets mode to cua", () => {
    configure({ ai: { mode: "cua" } });
    expect(getMode()).toBe("cua");
  });

  it("mode survives merges with other config", () => {
    configure({ ai: { mode: "cua" } });
    configure({ uploadBasePath: "./tmp" });
    expect(getMode()).toBe("cua");
  });

  it("default cua model is gpt-5.5", () => {
    expect(getModelId("cua")).toBe("gpt-5.5");
    expect(DEFAULT_MODELS.cua).toBe("gpt-5.5");
  });

  it("configure throws when user tries to override cua model", () => {
    expect(() => configure({ ai: { models: { cua: "custom-cua-model" } } })).toThrow(
      /cua.*not user-configurable/,
    );
    // Default still wins.
    expect(getModelId("cua")).toBe("gpt-5.5");
  });
});

describe("resolveAI", () => {
  beforeEach(() => {
    resetConfig();
  });

  it("returns global mode/gateway with no overrides", () => {
    configure({ ai: { mode: "cua", gateway: "none" } });
    const r = resolveAI();
    expect(r.mode).toBe("cua");
    expect(r.gateway).toBe("none");
  });

  it("falls back to defaults when nothing is configured", () => {
    const r = resolveAI();
    expect(r.mode).toBe("snapshot");
    expect(r.gateway).toBe("none");
  });

  it("override flips mode without touching global", () => {
    configure({ ai: { gateway: "openrouter" } });
    const r = resolveAI({ mode: "cua", gateway: "none" });
    expect(r.mode).toBe("cua");
    expect(r.gateway).toBe("none");
    // Global is untouched.
    expect(getMode()).toBe("snapshot");
  });

  it("step override beats call override beats global", () => {
    configure({ ai: { mode: "snapshot", gateway: "openrouter" } });
    const callLevel = { mode: "snapshot" as const, gateway: "vercel" as const };
    const stepLevel = { mode: "cua" as const, gateway: "none" as const };
    const r = resolveAI(callLevel, stepLevel);
    expect(r.mode).toBe("cua");
    expect(r.gateway).toBe("none");
  });

  it("layer-aware getModelId picks step > call > global > default", () => {
    configure({ ai: { models: { stepExecution: "global/model" } } });
    const callLevel = { models: { stepExecution: "call/model" } };
    const stepLevel = { models: { stepExecution: "step/model" } };
    expect(resolveAI().getModelId("stepExecution")).toBe("global/model");
    expect(resolveAI(callLevel).getModelId("stepExecution")).toBe("call/model");
    expect(resolveAI(callLevel, stepLevel).getModelId("stepExecution")).toBe("step/model");
    // Falls through to DEFAULT_MODELS for keys nobody set.
    expect(resolveAI().getModelId("utility")).toBe(DEFAULT_MODELS.utility);
  });

  it("throws when an override sets models.cua (lock applies per-layer)", () => {
    expect(() => resolveAI({ models: { cua: "custom-cua" } })).toThrow(
      /cua.*not user-configurable/,
    );
  });

  it("undefined override layers are ignored", () => {
    configure({ ai: { mode: "cua" } });
    const r = resolveAI(undefined, undefined);
    expect(r.mode).toBe("cua");
  });
});
