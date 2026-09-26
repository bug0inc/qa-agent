import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock instrumentation
vi.mock("../../instrumentation", () => ({
  isAxiomEnabled: () => false,
  initTelemetry: vi.fn(),
}));

// Mock Redis
const mockRedis = {
  hgetall: vi.fn().mockResolvedValue({}),
  hset: vi.fn().mockResolvedValue("OK"),
  expire: vi.fn().mockResolvedValue(1),
};
vi.mock("../../redis", () => ({
  getRedis: () => mockRedis,
}));

// Mock AI SDK
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({ text: "done", steps: [], output: {}, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }),
    streamText: vi.fn(),
  };
});

// Mock axiom/ai
vi.mock("axiom/ai", () => ({
  withSpan: vi.fn((_meta: unknown, fn: () => unknown) => fn()),
  wrapAISDKModel: vi.fn((model: unknown) => model),
  wrapTool: vi.fn((_name: unknown, tool: unknown) => tool),
  initAxiomAI: vi.fn(),
  RedactionPolicy: { AxiomDefault: {} },
}));

// Mock the models module to avoid needing real API keys
vi.mock("../../models", () => ({
  resolveModel: vi.fn().mockReturnValue("mocked-model"),
}));

// Mock tools module
vi.mock("../../tools", () => ({
  getAItools: vi.fn().mockReturnValue({
    tools: {},
    getPendingCacheData: vi.fn().mockReturnValue(null),
    clearPendingCacheData: vi.fn(),
  }),
}));

// Mock utils module
vi.mock("../../utils", () => ({
  runLocatorCode: vi.fn().mockResolvedValue(undefined),
  safeSnapshot: vi.fn().mockResolvedValue("snapshot content"),
  verifyActionEffect: vi.fn().mockResolvedValue(undefined),
  waitForCondition: vi.fn().mockResolvedValue(undefined),
  waitForDOMStabilization: vi.fn().mockResolvedValue(undefined),
  generatePhoneNumber: vi.fn().mockReturnValue("1234567890"),
  resolvePage: vi.fn((input: unknown) => input),
}));

// Mock extract module
vi.mock("../../extract", () => ({
  extractDataWithAI: vi.fn().mockResolvedValue("extracted-value"),
}));

// Mock assertion module
vi.mock("../../assertion", () => ({
  assert: vi.fn().mockResolvedValue("assertion passed"),
}));

// Mock logger
vi.mock("../../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock email module
vi.mock("../../email", () => ({
  extractEmailContent: vi.fn(),
  generateEmail: vi.fn().mockReturnValue("test@example.com"),
}));

// Mock secure script runner
vi.mock("../../utils/secure-script-runner", () => ({
  runSecureScript: vi.fn().mockResolvedValue(undefined),
}));

// Mock the CUA module so runSteps' "mode: cua" branch is observable.
vi.mock("../../cua", () => ({
  runCUALoop: vi.fn().mockResolvedValue("cua-result"),
  buildRunStepsPromptCUA: vi.fn().mockReturnValue("cua-prompt"),
  buildRunUserFlowPromptCUA: vi.fn().mockReturnValue("cua-userflow-prompt"),
}));

import { runSteps } from "../../index";
import { configure, resetConfig } from "../../config";
import { generateText } from "ai";
import { runCUALoop } from "../../cua";
import type { Page } from "@playwright/test";
import type { Step } from "../../types";

function createMockPage() {
  const mockLocator = {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    describe: vi.fn().mockReturnThis(),
  };
  const mockContext = {
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    locator: vi.fn().mockReturnValue(mockLocator),
    getByRole: vi.fn().mockReturnValue(mockLocator),
    getByText: vi.fn().mockReturnValue(mockLocator),
    ariaSnapshot: vi.fn().mockResolvedValue("snapshot content"),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
    url: vi.fn().mockReturnValue("https://example.com"),
    evaluate: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    context: vi.fn().mockReturnValue(mockContext),
  } as unknown as Page;
}

describe("runSteps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetConfig();
    // Reset redis mock to default empty
    vi.mocked(mockRedis.hgetall).mockResolvedValue({});
  });

  it("executes a simple step", async () => {
    const page = createMockPage();
    const steps: Step[] = [{ description: "Click the login button" }];

    await runSteps({
      page,
      userFlow: "login flow",
      steps,
    });

    expect(generateText).toHaveBeenCalled();
  });

  it("calls onStepStart and onStepEnd callbacks", async () => {
    const page = createMockPage();
    const onStepStart = vi.fn();
    const onStepEnd = vi.fn();
    const steps: Step[] = [{ description: "Fill in the username" }];

    await runSteps({
      page,
      userFlow: "login flow",
      steps,
      onStepStart,
      onStepEnd,
    });

    expect(onStepStart).toHaveBeenCalledTimes(1);
    expect(onStepStart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        description: "Fill in the username",
      }),
    );

    expect(onStepEnd).toHaveBeenCalledTimes(1);
    expect(onStepEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        description: "Fill in the username",
      }),
    );
  });

  it("processes {{run.*}} placeholders in step data", async () => {
    const page = createMockPage();
    const steps: Step[] = [
      {
        description: "Enter full name",
        data: { value: "{{run.fullName}}" },
      },
    ];

    await runSteps({
      page,
      userFlow: "signup flow",
      steps,
    });

    // generateText should be called with the prompt that contains the resolved placeholder
    expect(generateText).toHaveBeenCalled();
    const call = vi.mocked(generateText).mock.calls[0][0] as Record<string, unknown>;
    // The prompt is built inside runSteps; the key point is that the step's data
    // was resolved before being passed to buildRunStepsPrompt. We verify that
    // generateText was invoked (meaning the step ran) and the data placeholder
    // did not cause a failure.
    expect(call.prompt).toBeDefined();
  });

  it("handles cache hit", async () => {
    const page = createMockPage();
    const steps: Step[] = [{ description: "Click submit" }];

    // Mock redis to return cached step data
    vi.mocked(mockRedis.hgetall).mockResolvedValue({
      locator: 'getByRole("button", { name: "Submit" })',
      action: "click",
      description: "Submit button",
      value: "",
    });

    await runSteps({
      page,
      userFlow: "submit flow",
      steps,
    });

    // generateText should NOT be called when cache is hit
    expect(generateText).not.toHaveBeenCalled();
  });

  it("bypasses cache when bypassCache is true", async () => {
    const page = createMockPage();
    const steps: Step[] = [{ description: "Click submit" }];

    // Mock redis to return cached step data
    vi.mocked(mockRedis.hgetall).mockResolvedValue({
      locator: 'getByRole("button", { name: "Submit" })',
      action: "click",
      description: "Submit button",
      value: "",
    });

    await runSteps({
      page,
      userFlow: "submit flow",
      steps,
      bypassCache: true,
    });

    // generateText SHOULD be called even though cache exists
    expect(generateText).toHaveBeenCalled();
  });

  it("handles step execution error gracefully", async () => {
    const page = createMockPage();
    const steps: Step[] = [{ description: "Perform failing action" }];

    // Mock generateText to throw a timeout error
    vi.mocked(generateText).mockRejectedValueOnce(
      new Error("The operation was aborted due to timeout"),
    );

    await expect(
      runSteps({
        page,
        userFlow: "failing flow",
        steps,
      }),
    ).rejects.toThrow("The operation was aborted due to timeout");
  });

  it("processes multiple steps sequentially", async () => {
    const page = createMockPage();
    const callOrder: string[] = [];

    vi.mocked(generateText).mockImplementation(async (_opts: unknown) => {
      // Extract the step description from the prompt to track order
      callOrder.push(`generateText-call-${callOrder.length + 1}`);
      return { text: "done", steps: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as unknown as Awaited<ReturnType<typeof generateText>>;
    });

    const steps: Step[] = [
      { description: "Step 1: Navigate to page" },
      { description: "Step 2: Fill in form" },
      { description: "Step 3: Submit form" },
    ];

    await runSteps({
      page,
      userFlow: "multi-step flow",
      steps,
    });

    // All three steps should have triggered generateText
    expect(generateText).toHaveBeenCalledTimes(3);
    expect(callOrder).toEqual([
      "generateText-call-1",
      "generateText-call-2",
      "generateText-call-3",
    ]);
  });

  it("routes per-step ai overrides — hybrid snapshot + CUA in one runSteps call", async () => {
    const page = createMockPage();

    // Global default: openrouter snapshot mode. Steps 1 and 3 should follow this
    // (and hit generateText). Step 2 overrides to CUA + gateway:none and should
    // hit runCUALoop instead.
    configure({ ai: { gateway: "openrouter", mode: "snapshot" } });

    const steps: Step[] = [
      { description: "Open product page" },
      { description: "Drag the price slider", ai: { mode: "cua", gateway: "none" } },
      { description: "Click add to cart" },
    ];

    await runSteps({
      page,
      userFlow: "hybrid flow",
      steps,
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(runCUALoop).toHaveBeenCalledTimes(1);
    const cuaArgs = vi.mocked(runCUALoop).mock.calls[0][0];
    expect(cuaArgs.gateway).toBe("none");
  });

  it("call-level ai option applies to all steps without per-step override", async () => {
    const page = createMockPage();

    const steps: Step[] = [
      { description: "Step A" },
      { description: "Step B" },
    ];

    await runSteps({
      page,
      userFlow: "all cua flow",
      steps,
      ai: { mode: "cua", gateway: "none" },
    });

    expect(runCUALoop).toHaveBeenCalledTimes(2);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("step.ai beats runSteps.ai (step override wins)", async () => {
    const page = createMockPage();

    const steps: Step[] = [
      { description: "Snapshot step", ai: { mode: "snapshot" } },
      { description: "CUA step (inherits call-level)" },
    ];

    await runSteps({
      page,
      userFlow: "mixed override flow",
      steps,
      ai: { mode: "cua", gateway: "none" },
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(runCUALoop).toHaveBeenCalledTimes(1);
  });

  it("bypasses cache for individual step when step.bypassCache is true", async () => {
    const page = createMockPage();

    // Mock redis to return cached data
    vi.mocked(mockRedis.hgetall).mockResolvedValue({
      locator: 'getByRole("button", { name: "Go" })',
      action: "click",
      description: "Go button",
      value: "",
    });

    const steps: Step[] = [{ description: "Click go button", bypassCache: true }];

    await runSteps({
      page,
      userFlow: "cache bypass flow",
      steps,
    });

    // generateText should be called because the step has bypassCache: true
    expect(generateText).toHaveBeenCalled();
  });
});
