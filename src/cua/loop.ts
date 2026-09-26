import type { Page } from "@playwright/test";
import type OpenAI from "openai";
import { type AIGateway, getModelId } from "../config";
import { logger } from "../logger";
import { waitForDOMStabilization } from "../utils";
import { executeAction, type ComputerAction } from "./actions";
import { getOpenAIClient } from "./client";

export type RunCUALoopOptions = {
  page: Page;
  /** Initial natural-language instruction sent to the model. */
  instruction: string;
  /** Maximum number of computer_call turns before giving up. */
  maxSteps: number;
  /** Abort the loop when this signal fires (maps to step/user-flow timeouts). */
  abortSignal?: AbortSignal;
  /** Callback fired with any reasoning text surfaced in the model output. */
  onReasoning?: (reasoning: string) => void;
  /** Optional override client (used by tests). */
  client?: OpenAI;
  /** Resolved per-call gateway. Must be "none" for CUA. Defaults to "none". */
  gateway?: AIGateway;
};

/**
 * Minimal local types for the Responses-API CUA surface. The installed OpenAI
 * SDK typings don't yet include the `computer` tool / `computer_call` item, so
 * we describe just the fields we read. Extra/unknown fields pass through.
 */
type CUAOutputItem = {
  type: string;
  id?: string;
  call_id?: string;
  actions?: ComputerAction[];
  action?: ComputerAction;
  summary?: Array<{ text?: string }>;
  content?: Array<{ text?: string }>;
  text?: string;
};

type CUAResponse = {
  id: string;
  output?: CUAOutputItem[];
  output_text?: string;
};

type OpenAIWithResponses = OpenAI & {
  responses: {
    create: (body: unknown, opts?: { signal?: AbortSignal }) => Promise<CUAResponse>;
  };
};

type OpenAIErrorLike = {
  status?: number;
  message?: string;
  error?: unknown;
  response?: { data?: unknown };
  body?: unknown;
};

/**
 * CUA action-loop.
 *
 * Protocol (OpenAI Responses API):
 *   1. Send initial instruction + the built-in `computer` tool.
 *   2. Read response.output for a `computer_call` item — if absent, the model is done.
 *   3. Execute each action in the call's `actions` array via Playwright.
 *   4. Take a screenshot, send it back as `computer_call_output` with the same
 *      `call_id`, chaining via `previous_response_id`.
 *   5. Loop until no more `computer_call` items (or maxSteps / abort).
 */
export async function runCUALoop({
  page,
  instruction,
  maxSteps,
  abortSignal,
  onReasoning,
  client,
  gateway,
}: RunCUALoopOptions): Promise<string> {
  const openai = (client ?? getOpenAIClient(gateway ?? "none")) as OpenAIWithResponses;
  const model = getModelId("cua");

  // Current (2026) API: gpt-5.5 uses the simpler `{ type: "computer" }` tool.
  // The model infers display dimensions from the screenshots it receives, so
  // no display_width/display_height/environment are sent in the tool spec.
  // (The legacy `computer_use_preview` tool + `computer-use-preview` model is
  // scheduled for shutdown on 2026-07-23.)
  const tool = { type: "computer" };

  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  logger.debug(
    `[cua] starting loop — model=${model} viewport=${viewport.width}x${viewport.height} maxSteps=${maxSteps}`,
  );

  const initialRequest = {
    model,
    reasoning: { effort: "medium" },
    tools: [tool],
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: instruction }],
      },
    ],
    truncation: "auto",
  };

  let response: CUAResponse;
  try {
    response = await openai.responses.create(initialRequest, { signal: abortSignal });
  } catch (err: unknown) {
    const e = err as OpenAIErrorLike;
    logger.error(
      `[cua] initial request failed: status=${e?.status ?? "?"} msg=${e?.message ?? err} ` +
        `model=${model} tool=${JSON.stringify(tool)} ` +
        `body=${JSON.stringify(e?.error ?? e?.response?.data ?? e?.body ?? {})}`,
    );
    // A generic 400 with no `param` usually means the account lacks access to
    // the CUA model or to the built-in `computer` tool on the Responses API.
    if (e?.status === 400) {
      logger.error(
        `[cua] if no "param" detail is shown above, verify your OpenAI API key has access to "${model}" ` +
          `and the built-in "computer" tool on the Responses API ` +
          `(https://platform.openai.com/settings/organization/limits).`,
      );
    }
    throw err;
  }

  for (let turn = 0; turn < maxSteps; turn++) {
    if (abortSignal?.aborted) {
      throw new Error("CUA loop aborted");
    }

    emitReasoning(response, onReasoning);

    const call = findComputerCall(response);
    if (!call) {
      logger.debug(`[cua] loop ended at turn=${turn} (no computer_call in output)`);
      return extractFinalText(response);
    }

    const actions = rewriteAddressBarNavigation(extractActions(call));
    for (const action of actions) {
      if (abortSignal?.aborted) throw new Error("CUA loop aborted");
      await executeAction(page, action);
    }

    await waitForDOMStabilization(page).catch((err) => {
      logger.debug(`[cua] waitForDOMStabilization failed (continuing): ${err}`);
    });

    const screenshotB64 = (await page.screenshot({ fullPage: false })).toString("base64");

    response = await openai.responses.create(
      {
        model,
        tools: [tool],
        previous_response_id: response.id,
        input: [
          {
            type: "computer_call_output",
            call_id: call.call_id,
            output: {
              type: "computer_screenshot",
              image_url: `data:image/png;base64,${screenshotB64}`,
            },
          },
        ],
        truncation: "auto",
      },
      { signal: abortSignal },
    );
  }

  logger.warn(`[cua] loop hit maxSteps=${maxSteps} without model stopping`);
  return extractFinalText(response);
}

/**
 * Extracts any `message`/`output_text` content from the final response so
 * callers (like `runUserFlow`) can feed it into the assertion-JSON parser.
 * Returns "" if there's no text content.
 */
function extractFinalText(response: CUAResponse): string {
  if (typeof response.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }
  const output = response.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    } else if (item.type === "output_text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n").trim();
}

function findComputerCall(response: CUAResponse): CUAOutputItem | null {
  const output = response.output;
  if (!Array.isArray(output)) return null;
  return output.find((item) => item?.type === "computer_call") ?? null;
}

/**
 * A computer_call may carry either an `actions[]` array (newer shape) or a
 * single `action` object (older shape). Normalize to an array.
 */
function extractActions(call: CUAOutputItem): ComputerAction[] {
  if (Array.isArray(call.actions)) return call.actions;
  if (call.action) return [call.action];
  return [];
}

/**
 * The CUA model often "navigates" by simulating the browser's address-bar
 * shortcut: keypress(Ctrl/Cmd+L) → type(url) → keypress(Enter). Playwright
 * drives the page directly and has no browser chrome, so those keypresses
 * are no-ops and navigation never happens. Detect that 3-action pattern and
 * collapse it into a single `goto` that uses page.goto() under the hood.
 */
function rewriteAddressBarNavigation(actions: ComputerAction[]): ComputerAction[] {
  const result: ComputerAction[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const b = actions[i + 1];
    const c = actions[i + 2];
    if (isAddressBarFocus(a) && isUrlType(b) && isEnter(c)) {
      const url = (b as { text: string }).text.trim();
      result.push({ type: "goto", url });
      logger.debug(`[cua] rewrote address-bar navigation pattern → goto ${url}`);
      i += 2;
      continue;
    }
    result.push(a);
  }
  return result;
}

function isAddressBarFocus(action: ComputerAction | undefined): boolean {
  if (!action || action.type !== "keypress") return false;
  const keys = ((action as { keys?: string[] }).keys ?? []).map((k) => k.toUpperCase());
  if (keys.length !== 2 || !keys.includes("L")) return false;
  return keys.some(
    (k) => k === "CTRL" || k === "CONTROL" || k === "META" || k === "CMD" || k === "COMMAND",
  );
}

function isUrlType(action: ComputerAction | undefined): boolean {
  if (!action || action.type !== "type") return false;
  const text = (action as { text?: string }).text;
  return typeof text === "string" && /^https?:\/\//i.test(text.trim());
}

function isEnter(action: ComputerAction | undefined): boolean {
  if (!action || action.type !== "keypress") return false;
  const keys = ((action as { keys?: string[] }).keys ?? []).map((k) => k.toUpperCase());
  return keys.length === 1 && (keys[0] === "ENTER" || keys[0] === "RETURN");
}

function emitReasoning(response: CUAResponse, onReasoning?: (r: string) => void) {
  if (!onReasoning) return;
  const output = response.output;
  if (!Array.isArray(output)) return;
  for (const item of output) {
    if (item.type === "reasoning" && Array.isArray(item.summary)) {
      for (const s of item.summary) {
        if (typeof s?.text === "string") onReasoning(s.text);
      }
    }
  }
}
