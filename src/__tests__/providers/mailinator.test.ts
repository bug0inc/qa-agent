import { describe, it, expect, vi, beforeEach } from "vitest";
import { mailinatorProvider } from "../../providers/mailinator";

vi.stubGlobal("fetch", vi.fn());

describe("mailinatorProvider", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns correct domain", () => {
    const provider = mailinatorProvider();
    expect(provider.domain).toBe("mailinator.com");
  });

  it("extracts email body successfully", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          msgs: [{ id: "msg-abc-123" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [{ body: "Your verification code is 847291. It expires in 10 minutes." }],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const provider = mailinatorProvider();
    const result = await provider.extractContent({
      email: "testuser@mailinator.com",
      prompt: "get the 6 digit verification code",
    });

    expect(result).toContain("847291");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends API key in headers when provided", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          msgs: [{ id: "msg-456" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [{ body: "Click here to reset your password: https://example.com/reset/abc" }],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const provider = mailinatorProvider({ apiKey: "my-test-api-key" });
    await provider.extractContent({
      email: "testuser@mailinator.com",
      prompt: "get the reset link",
    });

    const inboxRequestHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(inboxRequestHeaders).toEqual({
      Authorization: "Bearer my-test-api-key",
    });
  });

  it("sends no headers when no API key provided", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          msgs: [{ id: "msg-789" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [{ body: "Welcome! Your code is 123456" }],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const provider = mailinatorProvider();
    await provider.extractContent({
      email: "test@mailinator.com",
      prompt: "get the code",
    });

    const inboxRequestHeaders = fetchMock.mock.calls[0]?.[1]?.headers;
    expect(inboxRequestHeaders ?? {}).toEqual({});
  });

  it("throws when inbox has no emails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ msgs: [] }),
    }));

    const provider = mailinatorProvider();

    await expect(
      provider.extractContent({
        email: "nobody@mailinator.com",
        prompt: "get the code",
      })
    ).rejects.toThrow("No emails found for nobody@mailinator.com");
  });

  it("throws when inbox API call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
    }));

    const provider = mailinatorProvider();

    await expect(
      provider.extractContent({
        email: "test@mailinator.com",
        prompt: "get the code",
      })
    ).rejects.toThrow("HTTP 429");
  });

  it("throws when message API call fails", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          msgs: [{ id: "msg-123" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
    );

    const provider = mailinatorProvider();

    await expect(
      provider.extractContent({
        email: "test@mailinator.com",
        prompt: "get the code",
      })
    ).rejects.toThrow("HTTP 500");
  });

  it("throws when email body is empty", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          msgs: [{ id: "msg-empty" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          parts: [{ body: "" }],
        }),
      })
    );

    const provider = mailinatorProvider();

    await expect(
      provider.extractContent({
        email: "test@mailinator.com",
        prompt: "get the code",
      })
    ).rejects.toThrow("Email body is empty");
  });
});