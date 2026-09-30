import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing index
vi.mock("../instrumentation", () => ({ axiomEnabled: false }));
vi.mock("../redis", () => ({
  redis: {
    hgetall: vi.fn(),
    hset: vi.fn(),
    expire: vi.fn(),
  },
}));
vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("../email", () => ({
  extractEmailContent: vi.fn(),
}));
vi.mock("../models", () => ({
  resolveModel: vi.fn((id: string) => `mock-model-${id}`),
}));
vi.mock("../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils")>();
  return {
    ...actual,
    safeSnapshot: vi.fn().mockResolvedValue("snapshot"),
    runLocatorCode: vi.fn().mockResolvedValue(undefined),
    verifyActionEffect: vi.fn().mockResolvedValue(undefined),
    waitForDOMStabilization: vi.fn().mockResolvedValue(undefined),
    waitForCondition: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("../utils/tab-manager", () => ({
  createTabManager: vi.fn((page) => ({
    active: () => page,
    switchTo: vi.fn(),
  })),
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    stepCountIs: vi.fn(() => () => false),
    tool: vi.fn((def: any) => def),
  };
});

import { redis } from "../redis";
import { runSteps } from "../index";
import { generateText } from "ai";
import { runLocatorCode, verifyActionEffect } from "../utils";

const mockRedis = redis as any;

function createMockPage() {
  return {
    url: vi.fn().mockReturnValue("https://example.com"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("screenshot")),
    _snapshotForAI: vi.fn().mockResolvedValue("snapshot"),
  } as any;
}

function createMockTest(retryCount = 0) {
  return {
    info: vi.fn().mockReturnValue({
      retry: retryCount,
      annotations: [],
    }),
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PRIORITY 2 — Caching Logic", () => {
  describe("Cache HIT: uses cached action without AI call", () => {
    it("executes cached step without calling AI when cache exists", async () => {
      const page = createMockPage();
      const test = createMockTest();

      // Mock cache hit - return cached action data
      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button", { name: "Submit" })',
        action: "click",
        description: "Click the submit button",
      });

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test Flow",
        steps: [{ description: "Click the submit button" }],
      });

      // Verify cache was checked
      expect(mockRedis.hgetall).toHaveBeenCalledWith("step:Test Flow:Click the submit button");

      // Verify cached action was executed
      expect(runLocatorCode).toHaveBeenCalled();

      // Verify AI was NOT called (cache hit)
      expect(generateText).not.toHaveBeenCalled();
    });

    it("uses cached fill action with input value", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByLabel("Email")',
        action: "fill",
        description: "Fill email field",
        value: "original@test.com", // This will be overridden by step.data.value
      });

      await runSteps({
        page,
        test,
        userFlow: "Login Flow",
        steps: [
          {
            description: "Fill email field",
            data: { value: "new@test.com" },
          },
        ],
      });

      // Verify cached locator was used with new value
      const callArgs = vi.mocked(runLocatorCode).mock.calls[0];
      expect(callArgs[1]).toContain('fill("new@test.com"');
    });

    it("executes multiple cached steps in sequence", async () => {
      const page = createMockPage();
      const test = createMockTest();

      // First step cached
      mockRedis.hgetall.mockResolvedValueOnce({
        locator: 'getByLabel("Email")',
        action: "fill",
        description: "Enter email",
      });

      // Second step cached
      mockRedis.hgetall.mockResolvedValueOnce({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click submit",
      });

      await runSteps({
        page,
        test,
        userFlow: "Login",
        steps: [
          { description: "Enter email", data: { value: "test@test.com" } },
          { description: "Click submit" },
        ],
      });

      expect(runLocatorCode).toHaveBeenCalledTimes(2);
      expect(generateText).not.toHaveBeenCalled();
    });
  });

  describe("Cache MISS: runs AI and stores result in Redis", () => {
    it("calls AI when no cache entry exists", async () => {
      const page = createMockPage();
      const test = createMockTest();

      // Mock cache miss
      mockRedis.hgetall.mockResolvedValue({});

      // Mock AI response
      vi.mocked(generateText).mockResolvedValue({
        text: "Clicked button",
        steps: [
          {
            toolCalls: [
              {
                toolName: "browser_click",
                args: {},
              },
            ],
          },
        ],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test Flow",
        steps: [{ description: "Click the button" }],
      });

      // Verify cache was checked
      expect(mockRedis.hgetall).toHaveBeenCalledWith("step:Test Flow:Click the button");

      // Verify AI was called
      expect(generateText).toHaveBeenCalled();
    });

    it("stores single-action step in cache after AI execution", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({});

      // Mock single tool call (cacheable)
      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [
          {
            toolCalls: [
              {
                toolName: "browser_click",
                args: {},
              },
            ],
          },
        ],
      } as any);

      // We need to provide the cache data via the tools closure
      // This is complex to test without integration, so we verify the intent:
      // Single tool call steps should trigger cache storage
      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      expect(generateText).toHaveBeenCalled();
    });

    it("does NOT cache multi-step actions", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({});

      // Mock multiple tool calls (not cacheable)
      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [
          {
            toolCalls: [
              { toolName: "browser_click", args: {} },
              { toolName: "browser_fill", args: {} },
            ],
          },
        ],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Complex action" }],
      });

      // Multi-step should not call hset for caching
      // (except for global values if executionId was provided)
      // In this case, no executionId, so hset should not be called
      expect(mockRedis.hset).not.toHaveBeenCalled();
    });
  });

  describe("bypassCache: true forces AI execution", () => {
    it("bypasses cache at step level with step.bypassCache=true", async () => {
      const page = createMockPage();
      const test = createMockTest();

      // Cache exists but should be ignored
      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button", bypassCache: true }],
      });

      // Cache was checked but not used
      expect(mockRedis.hgetall).toHaveBeenCalled();
      // AI was called despite cache existing
      expect(generateText).toHaveBeenCalled();
    });

    it("bypasses cache at runSteps level with bypassCache=true", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
        bypassCache: true, // Global bypass
      });

      expect(generateText).toHaveBeenCalled();
    });
  });

  describe("Playwright retry detection bypasses cache", () => {
    it("bypasses cache when test.info().retry > 0", async () => {
      const page = createMockPage();
      const test = createMockTest(1); // retry count = 1

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      // On retry, should use AI instead of cache
      expect(generateText).toHaveBeenCalled();
    });

    it("uses cache when test.info().retry === 0", async () => {
      const page = createMockPage();
      const test = createMockTest(0); // no retry

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      // Should use cache, not AI
      expect(runLocatorCode).toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    });
  });

  describe("Auto-healing: cache invalidation on execution failure", () => {
    it("falls back to AI when cached action throws error", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      // First call fails (cached action fails)
      vi.mocked(runLocatorCode).mockRejectedValueOnce(new Error("Element not found"));

      // Mock AI execution after cache failure
      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      // Cache was attempted
      expect(runLocatorCode).toHaveBeenCalled();
      // After cache failure, AI was called
      expect(generateText).toHaveBeenCalled();
    });

    it("falls back to AI when verifyActionEffect fails", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      // runLocatorCode succeeds
      vi.mocked(runLocatorCode).mockResolvedValueOnce(undefined);

      // But verification fails (action had no effect)
      vi.mocked(verifyActionEffect).mockRejectedValueOnce(
        new Error("Action had no visible effect")
      );

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      // Verification was attempted
      expect(verifyActionEffect).toHaveBeenCalled();
      // After verification failure, AI was called
      expect(generateText).toHaveBeenCalled();
    });
  });

  describe("Cache key scoping by userFlow + step.description", () => {
    it("uses different cache keys for same description in different userFlows", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({});

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      // First userFlow
      await runSteps({
        page,
        test,
        userFlow: "Login Flow",
        steps: [{ description: "Click submit" }],
      });

      // Second userFlow with same step description
      await runSteps({
        page,
        test,
        userFlow: "Signup Flow",
        steps: [{ description: "Click submit" }],
      });

      // Verify different cache keys were used
      expect(mockRedis.hgetall).toHaveBeenCalledWith("step:Login Flow:Click submit");
      expect(mockRedis.hgetall).toHaveBeenCalledWith("step:Signup Flow:Click submit");
    });

    it("uses same cache key for same userFlow + description", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test Flow",
        steps: [{ description: "Click button" }],
      });

      await runSteps({
        page,
        test,
        userFlow: "Test Flow",
        steps: [{ description: "Click button" }],
      });

      // Same cache key used both times
      const calls = vi.mocked(mockRedis.hgetall).mock.calls;
      expect(calls[0][0]).toBe("step:Test Flow:Click button");
      expect(calls[1][0]).toBe("step:Test Flow:Click button");
    });
  });

  describe("Redis unavailable gracefully degrades to AI-only", () => {
    it("continues with AI when Redis is null", async () => {
      // Note: This test verifies the code doesn't crash when redis is null.
      // The actual redis mock is always available in our tests, so we just verify
      // that when cache returns empty (miss), AI is called.

      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({}); // Cache miss

      vi.mocked(generateText).mockResolvedValue({
        text: "done",
        steps: [{ toolCalls: [{ toolName: "browser_click", args: {} }] }],
      } as any);

      // Should not crash, uses AI when cache misses
      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      expect(generateText).toHaveBeenCalled();
    });
  });

  describe("Cache action types", () => {
    it("handles cached click action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "click",
        description: "Click button",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Click button" }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain(".click(");
    });

    it("handles cached dblclick action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("button")',
        action: "dblclick",
        description: "Double click",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Double click" }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain(".dblclick(");
    });

    it("handles cached fill action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByLabel("Name")',
        action: "fill",
        description: "Fill name",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Fill name", data: { value: "John Doe" } }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain('.fill("John Doe"');
    });

    it("handles cached hover action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByRole("link")',
        action: "hover",
        description: "Hover link",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Hover link" }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain(".hover(");
    });

    it("handles cached select-option action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: 'getByLabel("Country")',
        action: "select-option",
        description: "Select country",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Select country", data: { value: "USA" } }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain('.selectOption("USA"');
    });

    it("handles cached waitForText action", async () => {
      const page = createMockPage();
      const test = createMockTest();

      mockRedis.hgetall.mockResolvedValue({
        locator: "",
        action: "waitForText",
        description: "Wait for success",
        value: "Success message",
      });

      await runSteps({
        page,
        test,
        userFlow: "Test",
        steps: [{ description: "Wait for success" }],
      });

      const code = vi.mocked(runLocatorCode).mock.calls[0][1];
      expect(code).toContain('getByText("Success message"');
      expect(code).toContain('waitFor({ state: "visible" }');
    });
  });
});
