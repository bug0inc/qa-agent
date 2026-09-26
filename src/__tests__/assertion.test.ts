import { describe, it, expect, vi, beforeEach } from "vitest";

// Disable Axiom instrumentation
vi.mock("../instrumentation", () => ({
  isAxiomEnabled: () => false,
  initTelemetry: vi.fn(),
}));

// Mock models.resolveModel to return the model id string so our AI mock can
// branch based on the model identifier.
vi.mock("../models", () => ({
  resolveModel: (id: string) => id,
}));

// Mock logger to silence output
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the AI SDK - return mocked functions we can control in tests
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    generateObject: vi.fn(),
    streamText: vi.fn(),
  };
});

// Mock utils used by the assertion flow
vi.mock("../utils", () => ({
  safeSnapshot: vi.fn().mockResolvedValue("snapshot content"),
  withTimeout: vi.fn((p: Promise<unknown>) => p),
  resolvePage: vi.fn((input: unknown) => input),
}));

import { assert } from "../assertion";
import { configure, resetConfig } from "../config";
import { withTimeout } from "../utils";
import { generateText } from "ai";

function createMockPage() {
  return {
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
    _snapshotForAI: vi.fn().mockResolvedValue("snapshot content"),
  } as any;
}

const mockTest = { info: () => ({ annotations: [] }) } as any;

type AssertionObj = { assertionPassed: boolean; confidenceScore: number; reasoning: string };

// Helper: build a generateText mock impl that dispatches based on model id
// and whether a structured `output` was requested.
function makeGenerateTextImpl(opts: {
  claude: AssertionObj;
  gemini: AssertionObj | (() => AssertionObj);
  arbiter?: AssertionObj;
}) {
  return async (args: any) => {
    const model = String(args.model ?? "");
    const wantsStructured = Boolean(args.output);

    if (!wantsStructured) {
      // Claude's first call returns free-form text
      return { text: "claude text" } as any;
    }

    if (model.includes("anthropic")) {
      return { output: opts.claude } as any;
    }
    if (model.includes("gemini-3-flash")) {
      const g =
        typeof opts.gemini === "function" ? (opts.gemini as () => AssertionObj)() : opts.gemini;
      return { output: g } as any;
    }
    if (model.includes("3.1-pro-preview")) {
      return {
        output: opts.arbiter ?? {
          assertionPassed: false,
          confidenceScore: 0,
          reasoning: "no arbiter set",
        },
      } as any;
    }
    return { output: { assertionPassed: false, confidenceScore: 0, reasoning: "unknown" } } as any;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetConfig();
});

describe("assert consensus logic", () => {
  it("returns pass when both models agree", async () => {
    const page = createMockPage();

    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: looks good" },
        gemini: { assertionPassed: true, confidenceScore: 80, reasoning: "Gemini: OK" },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("✅ passed");
    expect(res).toContain("Gemini: OK");
    expect(generateText).toHaveBeenCalled();
  });

  it("returns fail when both models agree failure", async () => {
    const page = createMockPage();

    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: false, confidenceScore: 20, reasoning: "Claude: not found" },
        gemini: { assertionPassed: false, confidenceScore: 10, reasoning: "Gemini: nope" },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("❌ failed");
    expect(res).toContain("Gemini: nope");
  });

  it("consults arbiter when models disagree and arbiter decides pass", async () => {
    const page = createMockPage();

    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: true, confidenceScore: 95, reasoning: "Claude: yes" },
        gemini: { assertionPassed: false, confidenceScore: 30, reasoning: "Gemini: no" },
        arbiter: {
          assertionPassed: true,
          confidenceScore: 70,
          reasoning: "Arbiter: I side with Claude",
        },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("✅ passed");
    expect(res).toContain("Arbiter: I side with Claude");
  });

  it("consults arbiter when models disagree and arbiter decides fail", async () => {
    const page = createMockPage();

    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: true, confidenceScore: 60, reasoning: "Claude: yes" },
        gemini: { assertionPassed: false, confidenceScore: 40, reasoning: "Gemini: no" },
        arbiter: {
          assertionPassed: false,
          confidenceScore: 45,
          reasoning: "Arbiter: I disagree, it fails",
        },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("❌ failed");
    expect(res).toContain("Arbiter: I disagree, it fails");
  });

  it("retries once on transient model errors and succeeds", async () => {
    const page = createMockPage();

    let geminiCalls = 0;
    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: ok" },
        gemini: () => {
          geminiCalls += 1;
          if (geminiCalls === 1) {
            throw new Error("transient model error");
          }
          return {
            assertionPassed: true,
            confidenceScore: 80,
            reasoning: "Gemini: ok after retry",
          };
        },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("✅ passed");
    expect(res).toContain("Gemini: ok after retry");
    expect(geminiCalls).toBeGreaterThanOrEqual(2);
  });

  it("retries when model wrapper times out (withTimeout rejection)", async () => {
    const page = createMockPage();

    // Make withTimeout reject once to simulate timeout
    vi.mocked(withTimeout).mockImplementationOnce(
      () => Promise.reject(new Error("timed out")) as any,
    );

    vi.mocked(generateText).mockImplementation(
      makeGenerateTextImpl({
        claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: ok" },
        gemini: { assertionPassed: true, confidenceScore: 80, reasoning: "Gemini: ok" },
      }) as any,
    );

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(res).toContain("✅ passed");
  });
});

describe("consensusPolicy", () => {
  it('fails on disagreement when policy is "fail-on-disagreement" and skips the arbiter', async () => {
    configure({ assertions: { consensusPolicy: "fail-on-disagreement" } });

    const page = createMockPage();
    let arbiterCalled = false;

    vi.mocked(generateText).mockImplementation((async (args: any) => {
      const model = String(args.model ?? "");
      const wantsStructured = Boolean(args.output);
      if (!wantsStructured) return { text: "claude text" } as any;
      if (model.includes("anthropic")) {
        return { output: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude says pass" } } as any;
      }
      if (model.includes("3.1-pro-preview")) {
        arbiterCalled = true;
        return { output: { assertionPassed: true, confidenceScore: 80, reasoning: "Arbiter should NOT be called" } } as any;
      }
      if (model.includes("gemini-3-flash")) {
        return { output: { assertionPassed: false, confidenceScore: 70, reasoning: "Gemini says fail" } } as any;
      }
      return { output: { assertionPassed: false, confidenceScore: 0, reasoning: "unknown" } } as any;
    }) as any);

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
      maxRetries: 0, // skip the outer retry loop so we observe a single attempt
    });

    expect(arbiterCalled).toBe(false);
    expect(res).toContain("❌ failed");
    expect(res).toContain("Claude says pass");
    expect(res).toContain("Gemini says fail");
    expect(res).toContain("fail-on-disagreement");
  });

  it("still consults the arbiter on disagreement when policy is the default", async () => {
    // No configure() — should use default "consult-arbiter-on-disagreement"
    const page = createMockPage();
    let arbiterCalled = false;

    vi.mocked(generateText).mockImplementation((async (args: any) => {
      const model = String(args.model ?? "");
      const wantsStructured = Boolean(args.output);
      if (!wantsStructured) return { text: "claude text" } as any;
      if (model.includes("anthropic")) {
        return { output: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude says pass" } } as any;
      }
      if (model.includes("3.1-pro-preview")) {
        arbiterCalled = true;
        return { output: { assertionPassed: true, confidenceScore: 75, reasoning: "Arbiter: pass" } } as any;
      }
      if (model.includes("gemini-3-flash")) {
        return { output: { assertionPassed: false, confidenceScore: 70, reasoning: "Gemini says fail" } } as any;
      }
      return { output: { assertionPassed: false, confidenceScore: 0, reasoning: "unknown" } } as any;
    }) as any);

    const res = await assert({
      page,
      assertion: "The page shows 3 items",
      test: mockTest,
      expect: ((a: unknown, _m?: string) => ({ toBe: (_v: unknown) => {} })) as any,
      failSilently: true,
    });

    expect(arbiterCalled).toBe(true);
    expect(res).toContain("✅ passed");
    expect(res).toContain("Arbiter: pass");
  });
});
