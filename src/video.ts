import type { GoogleGenAI, Schema } from "@google/genai" with { "resolution-mode": "import" };
import { promises as fs } from "fs";
import { dirname, join } from "path";
import shortid from "shortid";
import { z } from "zod";

import { getConfig } from "./config";
import {
  VIDEO_ASSERTION_MODEL,
  VIDEO_DEFAULT_DIR,
  VIDEO_DEFAULT_HEIGHT,
  VIDEO_DEFAULT_WIDTH,
  VIDEO_FILE_POLL_INTERVAL,
  VIDEO_FILE_POLL_TIMEOUT,
} from "./constants";
import { AIModelError, ConfigurationError } from "./errors";
import { logger } from "./logger";
import { AssertionResult, PageInput } from "./types";
import { resolvePage } from "./utils";

const VIDEO_MIME_TYPE = "video/webm";

/**
 * Wraps a Playwright `page.screencast` recording for a single video assertion run.
 * Records to a unique file in the configured video directory; the file is
 * intended to be deleted by the caller once assertions complete.
 */
export class VideoRecorder {
  private started = false;
  private stopped = false;
  readonly filePath: string;

  constructor(
    private readonly page: PageInput,
    filePath?: string,
  ) {
    this.filePath = filePath ?? defaultVideoPath();
  }

  async start(): Promise<void> {
    if (this.started) return;
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    await resolvePage(this.page).screencast.start({
      path: this.filePath,
      size: { width: VIDEO_DEFAULT_WIDTH, height: VIDEO_DEFAULT_HEIGHT },
    });
    this.started = true;
    logger.debug({ path: this.filePath }, "Video recording started");
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    try {
      await resolvePage(this.page).screencast.stop();
      let sizeBytes: number | null = null;
      try {
        sizeBytes = (await fs.stat(this.filePath)).size;
      } catch {
        // File may not exist if save failed; sizeBytes stays null.
      }
      logger.debug({ path: this.filePath, sizeBytes }, "Video recording stopped");
    } catch (error) {
      logger.warn({ err: error }, "Failed to stop video recording cleanly");
    }
  }

  async cleanup(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
      logger.debug(`Deleted video file: ${this.filePath}`);
    } catch (error: unknown) {
      // ENOENT is fine — file may not have been saved if stop() failed
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn({ err: error }, `Failed to delete video file: ${this.filePath}`);
      }
    }
  }
}

function defaultVideoPath(): string {
  const dir = getConfig().videoDir ?? VIDEO_DEFAULT_DIR;
  return join(dir, `passmark-${shortid.generate()}.webm`);
}

const videoAssertionSchema = z.object({
  assertionPassed: z.boolean(),
  confidenceScore: z.number(),
  reasoning: z.string(),
});

let _genAI: GoogleGenAI | null = null;

async function getGenAI(): Promise<GoogleGenAI> {
  if (_genAI) return _genAI;
  const apiKey =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError(
      "Video assertions require a direct Gemini API key. Set GOOGLE_GENERATIVE_AI_API_KEY (preferred) or GEMINI_API_KEY in your environment. The video file is uploaded to Gemini's Files API regardless of any configured gateway.",
    );
  }
  // Dynamic import because @google/genai is shipped as ESM; the passmark
  // package itself is CommonJS.
  const { GoogleGenAI } = await import("@google/genai");
  _genAI = new GoogleGenAI({ apiKey });
  return _genAI;
}

/**
 * Uploads a video file to Gemini's Files API and polls until ACTIVE.
 * Returns the file resource that can be referenced from `generateContent`.
 */
export async function uploadVideoToGemini(filePath: string): Promise<{
  name: string;
  uri: string;
  mimeType: string;
}> {
  const ai = await getGenAI();
  logger.debug({ filePath }, "Uploading video to Gemini Files API");
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType: VIDEO_MIME_TYPE },
  });
  logger.debug({ name: uploaded.name, state: uploaded.state }, "Gemini Files API upload accepted");

  if (!uploaded.name) {
    throw new AIModelError("Gemini Files API did not return a file name after upload.");
  }

  const start = Date.now();
  let current = uploaded;
  while (current.state !== "ACTIVE") {
    if (current.state === "FAILED") {
      throw new AIModelError(
        `Gemini file processing failed: ${current.error?.message ?? "unknown error"}`,
      );
    }
    if (Date.now() - start > VIDEO_FILE_POLL_TIMEOUT) {
      throw new AIModelError(
        `Gemini file did not become ACTIVE within ${VIDEO_FILE_POLL_TIMEOUT}ms (last state: ${current.state}).`,
      );
    }
    await new Promise((r) => setTimeout(r, VIDEO_FILE_POLL_INTERVAL));
    current = await ai.files.get({ name: uploaded.name });
    logger.debug({ name: uploaded.name, state: current.state }, "Gemini file poll");
  }

  if (!current.uri || !current.mimeType) {
    throw new AIModelError("Gemini file is ACTIVE but is missing uri/mimeType.");
  }

  logger.debug(
    { name: uploaded.name, uri: current.uri, mimeType: current.mimeType },
    "Gemini file ACTIVE",
  );
  return { name: uploaded.name, uri: current.uri, mimeType: current.mimeType };
}

/**
 * Deletes a previously-uploaded Gemini file. Failures are logged but not thrown
 * so they never mask a real test failure.
 */
export async function deleteGeminiFile(name: string): Promise<void> {
  try {
    const ai = await getGenAI();
    await ai.files.delete({ name });
    logger.debug(`Deleted Gemini file: ${name}`);
  } catch (error) {
    logger.warn({ err: error }, `Failed to delete Gemini file: ${name}`);
  }
}

/**
 * Runs an assertion against a video already uploaded to Gemini.
 * Uses Gemini 3 Flash with a structured response schema. Unlike the
 * snapshot/screenshot path, this is a single-model call — Claude does not
 * accept video input, so consensus isn't available here.
 */
export async function assertVideoFile({
  assertion,
  fileUri,
  fileMimeType,
}: {
  assertion: string;
  fileUri: string;
  fileMimeType: string;
}): Promise<AssertionResult> {
  const prompt = `
You are an AI-powered QA Agent designed to test web applications.

You are given a screen recording of a user flow. Inspect the video carefully — pay particular attention to ephemeral UI such as toasts, banners, snackbars, or status messages that may appear and disappear within a second. Based on what you observe across the full video, determine whether the assertion below holds.

<Assertion>
${assertion}
</Assertion>

<Rules>
- Watch the entire video; the relevant evidence may appear only briefly.
- Consider any frame in the video as valid evidence — if the asserted state is visible at any point, the assertion passes.
- Don't add extra conditions beyond what the assertion states.
- Don't be overly strict about exact wording — focus on intent and observable state.
- Think like a practical QA tester.
</Rules>

<OutputFormat>
Return a JSON object with:
- assertionPassed: boolean
- confidenceScore: number between 0 and 100
- reasoning: brief string explaining your decision
</OutputFormat>

Never hallucinate. If unsure, use a low confidence score.
`;

  const ai = await getGenAI();
  const response = await ai.models.generateContent({
    model: VIDEO_ASSERTION_MODEL,
    contents: [
      {
        role: "user",
        parts: [{ fileData: { fileUri, mimeType: fileMimeType } }, { text: prompt }],
      },
    ],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          assertionPassed: { type: "BOOLEAN" },
          confidenceScore: { type: "NUMBER" },
          reasoning: { type: "STRING" },
        },
        required: ["assertionPassed", "confidenceScore", "reasoning"],
      } as unknown as Schema,
    },
  });

  const text = response.text;
  logger.debug({ text }, "Gemini video assertion raw response");
  if (!text) {
    throw new AIModelError("Gemini returned no text for the video assertion.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AIModelError(`Failed to parse Gemini video assertion JSON: ${text}`);
  }

  const result = videoAssertionSchema.safeParse(parsed);
  if (!result.success) {
    throw new AIModelError(
      `Gemini video assertion response did not match schema: ${JSON.stringify(parsed)}`,
    );
  }

  logger.debug(
    {
      assertionPassed: result.data.assertionPassed,
      confidenceScore: result.data.confidenceScore,
      reasoning: result.data.reasoning,
    },
    "Gemini video assertion verdict",
  );
  return result.data;
}
