import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure, resetConfig } from "../config";
import { generateEmail } from "../email";

beforeEach(() => {
  resetConfig();
});

describe("generateEmail", () => {
  it("throws when no email provider is configured", () => {
    expect(() => generateEmail()).toThrow("Email provider not configured");
  });

  it("returns correct format with configured provider", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const email = generateEmail({ timestamp: 1000 });
    expect(email).toBe("test.user.1000@test.com");
  });

  it("uses default prefix 'test.user'", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const email = generateEmail({ timestamp: 5555 });
    expect(email).toMatch(/^test\.user\.\d+@test\.com$/);
    expect(email).toBe("test.user.5555@test.com");
  });

  it("uses custom prefix", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const email = generateEmail({ prefix: "custom.prefix", timestamp: 9999 });
    expect(email).toBe("custom.prefix.9999@test.com");
  });

  it("uses provided timestamp", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const ts = 1234567890;
    const email = generateEmail({ timestamp: ts });
    expect(email).toBe(`test.user.${ts}@test.com`);
  });
});

describe("extractEmailContent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when no email provider is configured", async () => {
    const { extractEmailContent } = await import("../email");
    const promise = expect(
      extractEmailContent({ email: "test@domain.com", prompt: "code" })
    ).rejects.toThrow("Email provider not configured");
    
    await vi.runAllTimersAsync();
    await promise;
  });

  it("extracts content successfully on first attempt", async () => {
    const { extractEmailContent } = await import("../email");
    const extractContentMock = vi.fn().mockResolvedValue("extracted-123");
    configure({ email: { domain: "test.com", extractContent: extractContentMock } });
    
    const promise = extractEmailContent({
      email: "test@test.com",
      prompt: "get code",
      maxRetries: 3,
      retryDelayMs: 10,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(extractContentMock).toHaveBeenCalledTimes(1);
    expect(extractContentMock).toHaveBeenCalledWith({ email: "test@test.com", prompt: "get code" });
    expect(result).toBe("extracted-123");
  });

  it("retries on failure and succeeds eventually", async () => {
    const { extractEmailContent } = await import("../email");
    const extractContentMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Not found yet"))
      .mockRejectedValueOnce(new Error("Still not found"))
      .mockResolvedValueOnce("extracted-456");
      
    configure({ email: { domain: "test.com", extractContent: extractContentMock } });
    
    const promise = extractEmailContent({
      email: "test2@test.com",
      prompt: "get otp",
      maxRetries: 3,
      retryDelayMs: 10,
    });

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(extractContentMock).toHaveBeenCalledTimes(3);
    expect(result).toBe("extracted-456");
  });

it("throws AIModelError when max retries exceeded", async () => {
  const { extractEmailContent } = await import("../email");
  const extractContentMock = vi.fn().mockRejectedValue(new Error("Always fails"));

  configure({ email: { domain: "test.com", extractContent: extractContentMock } });

  const promise = extractEmailContent({
    email: "test3@test.com",
    prompt: "get code",
    maxRetries: 2,
    retryDelayMs: 10,
  });

  await vi.runAllTimersAsync();

  await expect(promise).rejects.toMatchObject({ name: "AIModelError", code: "AI_MODEL_ERROR" });
  await expect(promise).rejects.toThrow(
    "Failed to extract email content after 2 attempts. Email: test3@test.com, Prompt: get code"
  );

  expect(extractContentMock).toHaveBeenCalledTimes(2);
});
