import { tool } from "ai";
import { z } from "zod";
import { Locator, type Page } from "@playwright/test";
import { wrapTool } from "axiom/ai";
import shortid from "shortid";
import { getConfig } from "./config";
import { isAxiomEnabled } from "./instrumentation";
import { logger } from "./logger";
import { LOCATOR_ACTION_TIMEOUT, SNAPSHOT_TIMEOUT, STOP_DELAY } from "./constants";
import {
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from "@playwright/test";
import type { TabManager } from "./utils/tab-manager";

export function resolveUploadPath(filePath: string, uploadBasePath: string): string {
  return filePath.startsWith("/") || filePath.match(/^[A-Za-z]:/)
    ? filePath
    : `${uploadBasePath}/${filePath}`;
}

/**
 * Resolves the file paths a cached "uploadFile" step should attach. The two sources hold
 * different things: `rawValue` (from the step's data) is an unresolved filename, while
 * `cachedValue` was already resolved against the base path when the step was recorded and
 * must be used as-is — resolving it again would re-prefix it whenever `uploadBasePath` is
 * relative, which is the default.
 */
export function resolveCachedUploadPaths(
  rawValue: string | undefined,
  cachedValue: string | undefined,
  uploadBasePath: string,
): string[] {
  return (rawValue ?? cachedValue ?? "")
    .split(",")
    .map((filePath) => filePath.trim())
    .filter(Boolean)
    .map((filePath) =>
      rawValue === undefined ? filePath : resolveUploadPath(filePath, uploadBasePath),
    );
}

type ToolSettings = {
  abortController?: AbortController;
  currentStep?: { description: string; data?: Record<string, string> };
  test?: TestType<
    PlaywrightTestArgs & PlaywrightTestOptions,
    PlaywrightWorkerArgs & PlaywrightWorkerOptions
  >;
  /**
   * Optional tab manager. When provided, tools resolve the active page
   * dynamically and auto-switch to a newly opened tab after action tools.
   */
  tabManager?: TabManager;
};

export function getAItools(page: Page, settings?: ToolSettings) {
  const playwrightTools = new PlaywrightTools(page, settings);

  // Only wrap tools with Axiom instrumentation when Axiom is configured.
  // Resolved per-call so users who call `configure({ telemetry })` before
  // `runSteps` (rather than setting env vars) still get instrumentation.
  const maybeWrapTool: typeof wrapTool = isAxiomEnabled()
    ? wrapTool
    : <T>(_name: string, t: T): T => t;

  const withSnapshot = async <TArgs, TResult>(
    fn: (args: TArgs) => Promise<TResult>,
    args: TArgs,
  ) => {
    try {
      const result = await fn(args);

      // tab-manager's persistent 'page' listener auto-switches active focus
      // when a new tab opens, so getSnapshot() below targets it automatically.
      const snapshot = await playwrightTools.getSnapshot();
      return { ...result, snapshot };
    } catch (_error) {
      return `Error executing this action. Retry the action or try a different one.\n\nLatest Snapshot:\n\n${await playwrightTools.getSnapshot()}`;
    }
  };

  const tools = {
    browser_navigate: maybeWrapTool(
      "browser_navigate",
      tool({
        description:
          "Navigate to a URL. This tool should be used only when an explicit instruction to navigate is given in a particular step",
        inputSchema: playwrightTools.navigateSchema,
        execute: async (args) => withSnapshot(playwrightTools.navigate.bind(playwrightTools), args),
      }),
    ),
    browser_click: maybeWrapTool(
      "browser_click",
      tool({
        description: "Click on an element",
        inputSchema: playwrightTools.clickSchema,
        execute: async (args) => withSnapshot(playwrightTools.click.bind(playwrightTools), args),
      }),
    ),
    browser_type: maybeWrapTool(
      "browser_type",
      tool({
        description: "Type text into an element",
        inputSchema: playwrightTools.typeSchema,
        execute: async (args) => withSnapshot(playwrightTools.type.bind(playwrightTools), args),
      }),
    ),
    browser_take_screenshot: maybeWrapTool(
      "browser_take_screenshot",
      tool({
        description: "Take a screenshot",
        inputSchema: playwrightTools.screenshotSchema,
        execute: async (args) => {
          const fn = playwrightTools.takeScreenshot.bind(playwrightTools);
          const screenshot = await fn(args);
          return screenshot;
        },
        toModelOutput: (result) => {
          const base64 = (typeof result === "string" ? result : result.output) as string;
          return {
            type: "content",
            value: [
              { type: "media", data: base64, mediaType: "image/png" },
            ],
          };
        },
      }),
    ),
    browser_press_key: maybeWrapTool(
      "browser_press_key",
      tool({
        description: "Press a key",
        inputSchema: playwrightTools.pressKeySchema,
        execute: async (args) => withSnapshot(playwrightTools.pressKey.bind(playwrightTools), args),
      }),
    ),
    browser_navigate_back: maybeWrapTool(
      "browser_navigate_back",
      tool({
        description: "Go back to previous page",
        inputSchema: z.object({}),
        execute: async () => withSnapshot(playwrightTools.goBack.bind(playwrightTools), {}),
      }),
    ),
    browser_navigate_forward: maybeWrapTool(
      "browser_navigate_forward",
      tool({
        description: "Go forward to next page",
        inputSchema: z.object({}),
        execute: async () => withSnapshot(playwrightTools.goForward.bind(playwrightTools), {}),
      }),
    ),
    browser_reload: maybeWrapTool(
      "browser_reload",
      tool({
        description: "Reload the current page",
        inputSchema: z.object({
          reasoning: z.string().describe("A quick one-line reasoning behind this action"),
        }),
        execute: async (args) => withSnapshot(playwrightTools.reload.bind(playwrightTools), args),
      }),
    ),
    browser_snapshot: maybeWrapTool(
      "browser_snapshot",
      tool({
        description: "Take fresh snapshot of the current page",
        inputSchema: z.object({
          reasoning: z.string().describe("A quick one-line reasoning behind this action"),
        }),
        execute: async (_args) => {
          return await playwrightTools.getSnapshot();
        },
      }),
    ),
    browser_wait: maybeWrapTool(
      "browser_wait",
      tool({
        description: "Wait for a specified amount of time",
        inputSchema: playwrightTools.waitSchema,
        execute: async (args) => withSnapshot(playwrightTools.wait.bind(playwrightTools), args),
      }),
    ),
    browser_mouse_move: maybeWrapTool(
      "browser_mouse_move",
      tool({
        description: "Move the mouse to a specific coordinate",
        inputSchema: playwrightTools.mouseMoveSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.mouseMove.bind(playwrightTools), args),
      }),
    ),
    browser_mouse_down: maybeWrapTool(
      "browser_mouse_down",
      tool({
        description: "Press the left mouse button.",
        inputSchema: playwrightTools.mouseDownSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.mouseDown.bind(playwrightTools), args),
      }),
    ),
    browser_mouse_up: maybeWrapTool(
      "browser_mouse_up",
      tool({
        description: "Release the left mouse button",
        inputSchema: playwrightTools.mouseUpSchema,
        execute: async (args) => withSnapshot(playwrightTools.mouseUp.bind(playwrightTools), args),
      }),
    ),
    browser_select_dropdown_option: maybeWrapTool(
      "browser_select_dropdown_option",
      tool({
        description: "Select an option from a dropdown",
        inputSchema: playwrightTools.selectDropdownOptionSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.selectDropdownOption.bind(playwrightTools), args),
      }),
    ),
    browser_stop: maybeWrapTool(
      "browser_stop",
      tool({
        description: "Stop the user flow test",
        inputSchema: playwrightTools.stopSchema,
        execute: async (args) => playwrightTools.stop(args),
      }),
    ),
    browser_drag_and_drop: maybeWrapTool(
      "browser_drag_and_drop",
      tool({
        description: "Drag an element and drop it onto another element",
        inputSchema: playwrightTools.dragAndDropSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.dragAndDrop.bind(playwrightTools), args),
      }),
    ),
    browser_hover: maybeWrapTool(
      "browser_hover",
      tool({
        description: "Hover over an element",
        inputSchema: playwrightTools.hoverSchema,
        execute: async (args) => withSnapshot(playwrightTools.hover.bind(playwrightTools), args),
      }),
    ),
    browser_upload_file: maybeWrapTool(
      "browser_upload_file",
      tool({
        description: "Upload a file",
        inputSchema: playwrightTools.uploadFileSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.uploadFile.bind(playwrightTools), args),
      }),
    ),
    browser_trigger_blur: maybeWrapTool(
      "browser_trigger_blur",
      tool({
        description:
          "Trigger a blur event by clicking on the body. Useful for when an element needs to lose focus.",
        inputSchema: playwrightTools.triggerBlurSchema,
        execute: async (args) =>
          withSnapshot(playwrightTools.triggerBlur.bind(playwrightTools), args),
      }),
    ),
    get_unique_value: maybeWrapTool(
      "get_unique_value",
      tool({
        description: "Generate a unique value by appending a shortid to a prefix",
        inputSchema: playwrightTools.getUniqueValueSchema,
        execute: async (args) => playwrightTools.getUniqueValue(args),
      }),
    ),
  };

  return {
    tools,
    getPendingCacheData: () => playwrightTools.pendingCacheData,
    clearPendingCacheData: () => {
      playwrightTools.pendingCacheData = null;
    },
  };
}

class PlaywrightTools {
  private initialPage: Page;
  private tabManager?: TabManager;
  private currentStep;
  private abortController?: AbortController;
  public pendingCacheData: Record<string, string> | null = null;

  private get page(): Page {
    return this.tabManager ? this.tabManager.active() : this.initialPage;
  }

  constructor(page: Page, settings: ToolSettings = {}) {
    const { currentStep, abortController, tabManager } = settings;

    this.initialPage = page;
    this.tabManager = tabManager;
    this.currentStep = currentStep;
    this.abortController = abortController;
  }

  public async getSnapshot() {
    const snapshot = await this.page.ariaSnapshot({ mode: "ai", timeout: SNAPSHOT_TIMEOUT });
    return `url: ${this.page.url()}\n\n${snapshot}`;
  }

  public navigateSchema = z.object({
    url: z.string().describe("The URL to navigate to"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async navigate({ url }: z.infer<typeof this.navigateSchema>) {
    await this.page.goto(url, { waitUntil: "load" });
    return { success: true, url };
  }

  public clickSchema = z.object({
    ref: z.string().describe("The ref of the element to click"),
    elementDescription: z
      .string()
      .describe("A description of the element to click, used for debugging"),
    button: z
      .enum(["left", "right", "middle"])
      .optional()
      .describe("Button to click, defaults to left"),
    doubleClick: z
      .boolean()
      .optional()
      .describe("Whether to perform a double click instead of a single click"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async click({
    ref,
    elementDescription,
    button,
    doubleClick,
  }: z.infer<typeof this.clickSchema>) {
    const locator = this.page.locator(`aria-ref=${ref}`).describe(elementDescription);
    let cachedLocator = "";

    if (this.currentStep) {
      cachedLocator = await this.resolveLocator(locator);
    }

    if (doubleClick) {
      await locator.dblclick({ button, timeout: LOCATOR_ACTION_TIMEOUT });
    } else {
      await locator.click({ button, timeout: LOCATOR_ACTION_TIMEOUT });
    }

    this.prepareCacheData(cachedLocator, doubleClick ? "dblclick" : "click", elementDescription);

    return {
      success: true,
    };
  }

  public typeSchema = z.object({
    ref: z.string().describe("The ref of the element to type into"),
    elementDescription: z.string().describe("A description of the element, used for debugging"),
    text: z.string().describe("The text to type"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async type({ ref, elementDescription, text }: z.infer<typeof this.typeSchema>) {
    const locator = this.page.locator(`aria-ref=${ref}`).describe(elementDescription);
    let cachedLocator = "";

    if (this.currentStep) {
      cachedLocator = await this.resolveLocator(locator);
    }

    await locator.fill(text, { timeout: LOCATOR_ACTION_TIMEOUT });

    this.prepareCacheData(cachedLocator, "fill", elementDescription, text);

    return {
      success: true,
      text,
    };
  }

  public screenshotSchema = z.object({
    fullPage: z.boolean().describe("Whether to take a screenshot of the full scrollable page"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async takeScreenshot({ fullPage: _fullPage }: z.infer<typeof this.screenshotSchema>) {
    // temporarily disabling fullPage as it sometimes causes issues with vision based models if dimension is too large.
    // we can re-enable this in the future with some dimension checks and optimizations if needed
    const screenshot = (await this.page.screenshot({ fullPage: false })).toString("base64");
    return screenshot;
  }

  public pressKeySchema = z.object({
    key: z
      .string()
      .describe("Name of the key to press or a character to generate, such as `ArrowLeft` or `a`"),
  });
  public async pressKey({ key }: z.infer<typeof this.pressKeySchema>) {
    await this.page.keyboard.press(key);
    return { success: true, key };
  }

  public async goBack() {
    await this.page.goBack();
    return { success: true };
  }

  public async goForward() {
    await this.page.goForward();
    return { success: true };
  }

  public async reload() {
    await this.page.reload({ waitUntil: "load" });
    return { success: true };
  }

  public waitSchema = z.object({
    timeout: z.number().describe("Time to wait in milliseconds"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async wait({ timeout }: z.infer<typeof this.waitSchema>) {
    await this.page.waitForTimeout(timeout);
    return {
      success: true,
      timeout,
      message: `Waited for ${timeout}ms. You can either 1. wait more or 2. retry a previous action or 3. try a new action.`,
    };
  }

  public mouseMoveSchema = z.object({
    x: z.number().describe("x-coordinate to move to"),
    y: z.number().describe("y-coordinate to move to"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async mouseMove({ x, y }: z.infer<typeof this.mouseMoveSchema>) {
    await this.page.mouse.move(x, y);
    return { success: true };
  }

  public mouseDownSchema = z.object({
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async mouseDown(_: z.infer<typeof this.mouseDownSchema>) {
    await this.page.mouse.down();
    return { success: true };
  }

  public mouseUpSchema = z.object({
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async mouseUp(_: z.infer<typeof this.mouseUpSchema>) {
    await this.page.mouse.up();
    return { success: true };
  }

  public selectDropdownOptionSchema = z.object({
    ref: z.string().describe("The ref of the dropdown element to select from"),
    elementDescription: z
      .string()
      .describe("A description of the dropdown element, used for debugging"),
    value: z.string().describe("The value of the option to select"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async selectDropdownOption({
    ref,
    elementDescription,
    value,
  }: z.infer<typeof this.selectDropdownOptionSchema>) {
    const locator = this.page.locator(`aria-ref=${ref}`).describe(elementDescription);
    let cachedLocator = "";

    if (this.currentStep) {
      cachedLocator = await this.resolveLocator(locator);
    }

    await locator.selectOption(value, { timeout: LOCATOR_ACTION_TIMEOUT });

    this.prepareCacheData(cachedLocator, "selectOption", elementDescription, value);

    return { success: true, value };
  }

  public stopSchema = z.object({
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
  });
  public async stop(_: z.infer<typeof this.stopSchema>) {
    // brief sleep to ensure any ongoing navigation or actions are complete
    // before the agent loop terminates via the `hasToolCall("browser_stop")` stop condition
    await new Promise((resolve) => setTimeout(resolve, STOP_DELAY));
    return { success: true, message: "Execution stopped" };
  }

  public dragAndDropSchema = z.object({
    sourceRef: z.string().describe("The ref of the element to drag"),
    sourceElementDescription: z
      .string()
      .describe("A description of the source element being dragged, used for debugging"),
    targetRef: z.string().describe("The ref of the element to drop onto"),
    targetElementDescription: z
      .string()
      .describe("A description of the target element to drop onto, used for debugging"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async dragAndDrop({
    sourceRef,
    sourceElementDescription,
    targetRef,
    targetElementDescription,
  }: z.infer<typeof this.dragAndDropSchema>) {
    const sourceLocator = this.page
      .locator(`aria-ref=${sourceRef}`)
      .describe(sourceElementDescription);
    const targetLocator = this.page
      .locator(`aria-ref=${targetRef}`)
      .describe(targetElementDescription);

    // Use two hover steps to ensure dragover events fire correctly across browsers
    await sourceLocator.hover({ timeout: LOCATOR_ACTION_TIMEOUT });
    await this.page.mouse.down();
    await targetLocator.hover({ timeout: LOCATOR_ACTION_TIMEOUT });
    await targetLocator.hover({ timeout: LOCATOR_ACTION_TIMEOUT });
    await this.page.mouse.up();

    return {
      success: true,
    };
  }

  public hoverSchema = z.object({
    ref: z.string().describe("The ref of the element to hover over"),
    elementDescription: z
      .string()
      .describe("A description of the element to hover, used for debugging"),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async hover({ ref, elementDescription }: z.infer<typeof this.hoverSchema>) {
    const locator = this.page.locator(`aria-ref=${ref}`).describe(elementDescription);
    let cachedLocator = "";

    if (this.currentStep) {
      cachedLocator = await this.resolveLocator(locator);
    }

    await locator.hover({ timeout: LOCATOR_ACTION_TIMEOUT });

    this.prepareCacheData(cachedLocator, "hover", elementDescription);

    return {
      success: true,
    };
  }

  public uploadFileSchema = z.object({
    ref: z.string().describe('The ref of the "button" that triggers a FileChooser to upload files'),
    elementDescription: z.string().describe("A description of the element, used for debugging"),
    filePaths: z
      .array(z.string())
      .describe(
        "Array of file paths to upload. Can be absolute paths (e.g., '/tmp/file.png') or relative paths (e.g., 'document.pdf' which will be resolved against uploadBasePath)",
      ),
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async uploadFile({
    ref,
    elementDescription,
    filePaths,
  }: z.infer<typeof this.uploadFileSchema>) {
    const locator = this.page.locator(`aria-ref=${ref}`).describe(elementDescription);

    // We expect to find these files in the `./uploads` directory if no base path is configured
    const uploadBasePath = getConfig().uploadBasePath || "./uploads";
    const prefixedFilePaths = filePaths.map((filePath) => resolveUploadPath(filePath, uploadBasePath));

    let cachedLocator = "";

    if (this.currentStep) {
      cachedLocator = await this.resolveLocator(locator);
    }

    const fileChooserPromise = this.page.waitForEvent("filechooser");
    await locator.click({ timeout: LOCATOR_ACTION_TIMEOUT });
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(prefixedFilePaths, {
      timeout: LOCATOR_ACTION_TIMEOUT,
    });

    // Cached as a single "uploadFile" action: the locator stored is the button that opens
    // the file chooser, and the replay in index.ts performs both steps against it.
    this.prepareCacheData(
      cachedLocator,
      "uploadFile",
      elementDescription,
      prefixedFilePaths.join(","),
    );

    return {
      success: true,
      prefixedFilePaths,
    };
  }

  public triggerBlurSchema = z.object({
    reasoning: z.string().describe("A quick one-line reasoning behind this action"),
    doesActionAdvanceUsTowardsGoal: z
      .boolean()
      .describe(
        '"true" indicates high confidence that this action will advance us towards the goal. "false" indicates low confidence and could be an AI hallucination.',
      ),
  });
  public async triggerBlur(_args: z.infer<typeof this.triggerBlurSchema>) {
    await this.page.locator("body").click({ position: { x: 0, y: 0 } });

    return {
      success: true,
    };
  }

  public getUniqueValueSchema = z.object({
    prefix: z.string().describe('The prefix to prepend to the unique id, e.g. "Topic", "Username"'),
  });
  public async getUniqueValue({ prefix }: z.infer<typeof this.getUniqueValueSchema>) {
    const uniqueValue = `${prefix} ${shortid.generate()}`;
    return { success: true, value: uniqueValue };
  }

  private async resolveLocator(locator: Locator) {
    let generatedLocator = "";
    try {
      generatedLocator = (await locator.normalize()).toString();
    } catch (e) {
      logger.error({ err: e }, "Error generating locator");
    }
    return generatedLocator;
  }

  /**
   * Prepares cache data for a step action. Stores it on the instance
   * instead of writing to Redis directly. The caller (runSteps in index.ts)
   * decides whether to persist based on a logic (for now the number of tool calls).
   */
  private prepareCacheData(
    cachedLocator: string,
    action: string,
    elementDescription: string,
    value?: string,
  ) {
    if (!this.currentStep) {
      return;
    }

    const ACTIONS_THAT_REQUIRE_NO_LOCATOR = ["waitForText"];

    // Skip caching if no locator is provided, unless it's an action that doesn't require a locator
    if (!cachedLocator && ACTIONS_THAT_REQUIRE_NO_LOCATOR.indexOf(action) === -1) {
      return;
    }

    /**
     *  If the current step's data contains values that are also present in the generated locator, it's likely that the locator is overfitted to those specific values and may not be reusable in future runs.
     *  In such cases, we should avoid caching to prevent storing non-reusable locators.
     */
    let isCacheable = true;
    if (this.currentStep.data && cachedLocator) {
      for (const key in this.currentStep.data) {
        const dataValue = this.currentStep.data[key];
        if (cachedLocator.includes(dataValue)) {
          isCacheable = false;
          break;
        }
      }
    }

    if (isCacheable) {
      const cacheData: Record<string, string> = {
        action,
        description: elementDescription,
      };

      if (cachedLocator) {
        cacheData.locator = cachedLocator;
      }

      if (value) {
        cacheData.value = value;
      }

      this.pendingCacheData = cacheData;
    }
  }
}
