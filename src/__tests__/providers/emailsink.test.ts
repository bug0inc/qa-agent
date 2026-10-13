import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emailsinkProvider } from "../../providers/emailsink";

describe("emailsinkProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns a provider with correct domain", () => {
    const provider = emailsinkProvider({});
    expect(provider.domain).toBe("emailsink.dev");
  });

  it("extracts content successfully without api key", async () => {
    const mockResponse = { result: "123456" };
    (global.fetch as any).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValueOnce(mockResponse),
    });

    const provider = emailsinkProvider({});
    const content = await provider.extractContent({
      email: "test@emailsink.dev",
      prompt: "get code",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://get.emailsink.dev/?email=test%40emailsink.dev&prompt=get%20code"
    );
    expect(content).toBe("123456");
  });

  it("extracts content successfully with api key", async () => {
    const mockResponse = { result: "654321" };
    (global.fetch as any).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValueOnce(mockResponse),
    });

    const provider = emailsinkProvider({ apiKey: "my-secret-key" });
    const content = await provider.extractContent({
      email: "test2@emailsink.dev",
      prompt: "get otp",
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://get.emailsink.dev/?email=test2%40emailsink.dev&prompt=get%20otp&secret=my-secret-key"
    );
    expect(content).toBe("654321");
  });

  it("handles stringified json result", async () => {
    const mockResponse = { result: '{"result":"parsed-code"}' };
    (global.fetch as any).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValueOnce(mockResponse),
    });

    const provider = emailsinkProvider({});
    const content = await provider.extractContent({
      email: "test@emailsink.dev",
      prompt: "get code",
    });

    expect(content).toBe("parsed-code");
  });

  it("throws error when result is undefined", async () => {
    const mockResponse = {}; // no result
    (global.fetch as any).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValueOnce(mockResponse),
    });

    const provider = emailsinkProvider({});
    await expect(
      provider.extractContent({ email: "test@emailsink.dev", prompt: "code" })
    ).rejects.toThrow("No email content found");
  });

  it("throws error when result is empty string", async () => {
    const mockResponse = { result: "" };
    (global.fetch as any).mockResolvedValueOnce({
      json: vi.fn().mockResolvedValueOnce(mockResponse),
    });

    const provider = emailsinkProvider({});
    await expect(
      provider.extractContent({ email: "test@emailsink.dev", prompt: "code" })
    ).rejects.toThrow("No email content found");
  });
});
