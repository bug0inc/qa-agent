import { describe, it, expect, vi, beforeEach } from "vitest";

// Disable Axiom instrumentation
vi.mock("../instrumentation", () => ({ axiomEnabled: false }));

// Mock models.resolveModel
vi.mock("../models", () => ({
  resolveModel: (id: string) => id,
}));

// Mock logger
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock the AI SDK
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

// Mock utils
vi.mock("../utils", () => ({
  safeSnapshot: vi.fn().mockResolvedValue("snapshot content"),
  withTimeout: vi.fn((p: Promise<unknown>) => p),
  resolvePage: vi.fn((input: unknown) => input),
}));

import { assert } from "../assertion";
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

// Helper: build a generateText mock impl
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
      const g = typeof opts.gemini === "function" ? opts.gemini() : opts.gemini;
      return { output: g } as any;
    }
    if (model.includes("3.1-pro-preview")) {
      return {
        output:
          opts.arbiter ?? { assertionPassed: false, confidenceScore: 0, reasoning: "no arbiter" },
      } as any;
    }
    return { output: { assertionPassed: false, confidenceScore: 0, reasoning: "unknown" } } as any;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PRIORITY 3 — Assertion Consensus", () => {
  describe("Both models agree TRUE → assertion passes", () => {
    it("passes when Claude and Gemini both return true", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 95, reasoning: "Claude: pass" },
          gemini: { assertionPassed: true, confidenceScore: 90, reasoning: "Gemini: pass" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Dashboard shows 3 items",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(result).toContain("Gemini: pass");
    });

    it("calculates average confidence score when both agree", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 80, reasoning: "Claude OK" },
          gemini: { assertionPassed: true, confidenceScore: 60, reasoning: "Gemini OK" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Element visible",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      // Average of 80 and 60 should be 70
      expect(result).toContain("✅ passed");
    });
  });

  describe("Both models agree FALSE → assertion fails", () => {
    it("fails when Claude and Gemini both return false", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 10, reasoning: "Claude: fail" },
          gemini: { assertionPassed: false, confidenceScore: 15, reasoning: "Gemini: fail" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Element does not exist",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("❌ failed");
      expect(result).toContain("Gemini: fail");
    });

    it("averages confidence when both agree on failure", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 20, reasoning: "Claude no" },
          gemini: { assertionPassed: false, confidenceScore: 30, reasoning: "Gemini no" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Missing element",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      // Average: (20 + 30) / 2 = 25
      expect(result).toContain("❌ failed");
    });
  });

  describe("Models disagree → arbiter is called", () => {
    it("calls arbiter when Claude=true and Gemini=false", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: yes" },
          gemini: { assertionPassed: false, confidenceScore: 40, reasoning: "Gemini: no" },
          arbiter: { assertionPassed: true, confidenceScore: 75, reasoning: "Arbiter: yes" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Disputed assertion",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      // Arbiter should be called and decide
      expect(result).toContain("Arbiter: yes");
    });

    it("calls arbiter when Claude=false and Gemini=true", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 30, reasoning: "Claude: no" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: yes" },
          arbiter: { assertionPassed: false, confidenceScore: 55, reasoning: "Arbiter: no" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Another dispute",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("Arbiter: no");
    });
  });

  describe("Arbiter agrees with Claude → Claude's result wins", () => {
    it("passes when arbiter sides with Claude (both true)", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 95, reasoning: "Claude: pass" },
          gemini: { assertionPassed: false, confidenceScore: 20, reasoning: "Gemini: fail" },
          arbiter: { assertionPassed: true, confidenceScore: 80, reasoning: "Arbiter: I agree with Claude" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Test assertion",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(result).toContain("Arbiter: I agree with Claude");
    });

    it("fails when arbiter sides with Claude (both false)", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 25, reasoning: "Claude: fail" },
          gemini: { assertionPassed: true, confidenceScore: 70, reasoning: "Gemini: pass" },
          arbiter: { assertionPassed: false, confidenceScore: 60, reasoning: "Arbiter: Claude is right" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Test assertion",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("❌ failed");
      expect(result).toContain("Arbiter: Claude is right");
    });
  });

  describe("Arbiter agrees with Gemini → Gemini's result wins", () => {
    it("passes when arbiter sides with Gemini (both true)", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 40, reasoning: "Claude: fail" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: pass" },
          arbiter: { assertionPassed: true, confidenceScore: 75, reasoning: "Arbiter: Gemini is correct" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Test assertion",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(result).toContain("Arbiter: Gemini is correct");
    });

    it("fails when arbiter sides with Gemini (both false)", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 60, reasoning: "Claude: pass" },
          gemini: { assertionPassed: false, confidenceScore: 30, reasoning: "Gemini: fail" },
          arbiter: { assertionPassed: false, confidenceScore: 55, reasoning: "Arbiter: Gemini wins" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Test assertion",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("❌ failed");
      expect(result).toContain("Arbiter: Gemini wins");
    });
  });

  describe("API errors from models are handled gracefully", () => {
    it("retries once when Claude throws error", async () => {
      const page = createMockPage();

      let claudeCalls = 0;
      vi.mocked(generateText).mockImplementation(async (args: any) => {
        const model = String(args.model ?? "");
        const wantsStructured = Boolean(args.output);

        if (model.includes("anthropic")) {
          claudeCalls++;
          if (claudeCalls === 1) {
            throw new Error("Claude API timeout");
          }
          return {
            text: wantsStructured ? undefined : "text",
            output: wantsStructured
              ? { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: ok after retry" }
              : undefined,
          } as any;
        }

        // Gemini always succeeds
        return {
          output: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: ok" },
        } as any;
      });

      const result = await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(claudeCalls).toBeGreaterThanOrEqual(2);
    });

    it("retries once when Gemini throws error", async () => {
      const page = createMockPage();

      let geminiCalls = 0;
      vi.mocked(generateText).mockImplementation(async (args: any) => {
        const model = String(args.model ?? "");
        const wantsStructured = Boolean(args.output);

        if (model.includes("gemini-3-flash")) {
          geminiCalls++;
          if (geminiCalls === 1) {
            throw new Error("Gemini API error");
          }
          return {
            output: { assertionPassed: true, confidenceScore: 80, reasoning: "Gemini: ok retry" },
          } as any;
        }

        // Claude
        return {
          text: wantsStructured ? undefined : "text",
          output: wantsStructured
            ? { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: ok" }
            : undefined,
        } as any;
      });

      const result = await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(geminiCalls).toBeGreaterThanOrEqual(2);
    });

    it("retries once when arbiter throws error", async () => {
      const page = createMockPage();

      let arbiterCalls = 0;
      vi.mocked(generateText).mockImplementation(async (args: any) => {
        const model = String(args.model ?? "");
        const wantsStructured = Boolean(args.output);

        if (model.includes("3.1-pro-preview")) {
          arbiterCalls++;
          if (arbiterCalls === 1) {
            throw new Error("Arbiter timeout");
          }
          return {
            output: { assertionPassed: true, confidenceScore: 70, reasoning: "Arbiter: ok retry" },
          } as any;
        }

        if (model.includes("anthropic")) {
          return {
            text: wantsStructured ? undefined : "text",
            output: wantsStructured
              ? { assertionPassed: true, confidenceScore: 95, reasoning: "Claude: yes" }
              : undefined,
          } as any;
        }

        // Gemini disagrees to trigger arbiter
        return {
          output: { assertionPassed: false, confidenceScore: 30, reasoning: "Gemini: no" },
        } as any;
      });

      const result = await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
      expect(arbiterCalls).toBeGreaterThanOrEqual(2);
    });

    it("throws error after retries are exhausted", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockRejectedValue(new Error("Persistent API failure"));

      await expect(
        assert({
          page,
          assertion: "Test",
          test: mockTest,
          expect: ((a: unknown) => ({ toBe: () => {} })) as any,
          failSilently: true,
        })
      ).rejects.toThrow("Persistent API failure");
    });

    it("handles timeout from withTimeout wrapper", async () => {
      const page = createMockPage();

      // Simulate one timeout, then success
      let timeoutCount = 0;
      vi.mocked(withTimeout).mockImplementation((p: Promise<unknown>) => {
        timeoutCount++;
        if (timeoutCount === 1) {
          return Promise.reject(new Error("Model timeout"));
        }
        return p;
      });

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: ok" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: ok" },
        }) as any
      );

      const result = await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
      });

      expect(result).toContain("✅ passed");
    });
  });

  describe("Effort level affects thinking mode", () => {
    it("enables thinking mode when effort=high", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: pass" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: pass" },
        }) as any
      );

      await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
        effort: "high",
      });

      // Verify thinking config was passed
      const calls = vi.mocked(generateText).mock.calls;
      const anthropicCall = calls.find((c) => String(c[0]?.model).includes("anthropic"));
      expect(anthropicCall?.[0]?.providerOptions?.anthropic?.thinking).toBeDefined();
    });

    it("does not enable thinking mode when effort=low", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: pass" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: pass" },
        }) as any
      );

      await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
        effort: "low",
      });

      const calls = vi.mocked(generateText).mock.calls;
      const anthropicCall = calls.find((c) => String(c[0]?.model).includes("anthropic"));
      expect(anthropicCall?.[0]?.providerOptions).toBeUndefined();
    });
  });

  describe("Custom images support", () => {
    it("uses provided images instead of taking screenshot", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: pass" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: pass" },
        }) as any
      );

      const customImages = ["base64image1", "base64image2"];

      await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: ((a: unknown) => ({ toBe: () => {} })) as any,
        failSilently: true,
        images: customImages,
      });

      // Verify custom images were used
      const calls = vi.mocked(generateText).mock.calls;
      const firstCall = calls[0][0];
      const imageContent = firstCall?.messages?.[0]?.content;

      // Should have the custom images in the content
      expect(JSON.stringify(imageContent)).toContain("base64image1");
    });
  });

  describe("failSilently option", () => {
    it("does not call expect.toBe when failSilently=true", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: false, confidenceScore: 10, reasoning: "Claude: fail" },
          gemini: { assertionPassed: false, confidenceScore: 15, reasoning: "Gemini: fail" },
        }) as any
      );

      const mockExpect = vi.fn().mockReturnValue({ toBe: vi.fn() });

      await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: mockExpect as any,
        failSilently: true,
      });

      // When failSilently=true, expect.toBe should not be called
      const toBeCalls = mockExpect.mock.results.flatMap((r) => r.value?.toBe?.mock?.calls ?? []);
      expect(toBeCalls.length).toBe(0);
    });

    it("calls expect.toBe when failSilently=false", async () => {
      const page = createMockPage();

      vi.mocked(generateText).mockImplementation(
        makeGenerateTextImpl({
          claude: { assertionPassed: true, confidenceScore: 90, reasoning: "Claude: pass" },
          gemini: { assertionPassed: true, confidenceScore: 85, reasoning: "Gemini: pass" },
        }) as any
      );

      const toBeMock = vi.fn();
      const mockExpect = vi.fn().mockReturnValue({ toBe: toBeMock });

      await assert({
        page,
        assertion: "Test",
        test: mockTest,
        expect: mockExpect as any,
        failSilently: false,
      });

      // expect().toBe() should be called
      expect(toBeMock).toHaveBeenCalledWith(true);
    });
  });
});
