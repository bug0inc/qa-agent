import { describe, expect, it } from "vitest";
import { withTimeout, flowKey, generatePhoneNumber } from "../utils";

describe("withTimeout", () => {
  it("returns the resolved value when the promise resolves before the timeout", async () => {
    const promise = Promise.resolve("done");
    const result = await withTimeout(promise, 1000);
    expect(result).toBe("done");
  });

  it("rejects with a timeout error when the promise takes longer than ms", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 500, "late"));
    await expect(withTimeout(slow, 50)).rejects.toThrow("Promise timed out after 50 ms");
  });

  it("returns the promise as-is when enabled is false (no timeout wrapping)", async () => {
    const slow = new Promise<string>((resolve) => setTimeout(resolve, 100, "ok"));
    const result = await withTimeout(slow, 1, false);
    expect(result).toBe("ok");
  });

  it("propagates the original rejection when the promise rejects before the timeout", async () => {
    const failing = Promise.reject(new Error("original error"));
    await expect(withTimeout(failing, 1000)).rejects.toThrow("original error");
  });
});

describe("flowKey", () => {
  it("returns a deterministic key for the same input", () => {
    const a = flowKey("my-flow");
    const b = flowKey("my-flow");
    expect(a).toBe(b);
  });

  it("returns different keys for different flow names", () => {
    const a = flowKey("flow-a");
    const b = flowKey("flow-b");
    expect(a).not.toBe(b);
  });

  it("uses 'flow' as the default prefix and 16 chars for the hash", () => {
    const key = flowKey("test");
    expect(key).toMatch(/^flow:.{16}$/);
  });

  it("respects custom prefix and length options", () => {
    const key = flowKey("test", { prefix: "run", length: 8 });
    expect(key).toMatch(/^run:.{8}$/);
  });

  it("produces a different key when a secret is provided", () => {
    const plain = flowKey("my-flow");
    const withSecret = flowKey("my-flow", { secret: "s3cret" });
    expect(plain).not.toBe(withSecret);
  });

  it("returns the same key for the same flow and secret", () => {
  const a = flowKey("my-flow", { secret: "s3cret" });
  const b = flowKey("my-flow", { secret: "s3cret" });
  expect(a).toBe(b);
  });
  
  it("returns different keys for different secrets", () => {
  const a = flowKey("my-flow", { secret: "secret1" });
  const b = flowKey("my-flow", { secret: "secret2" });
  expect(a).not.toBe(b);
  });

  it("produces different keys for same secret but different flows", () => {
  const a = flowKey("flow-a", { secret: "s3cret" });
  const b = flowKey("flow-b", { secret: "s3cret" });
  expect(a).not.toBe(b);
  });
});

describe("generatePhoneNumber", () => {
  it("returns a 10-digit string", () => {
    const phone = generatePhoneNumber();
    expect(phone).toMatch(/^\d{10}$/);
  });

  it("does not start with zero", () => {
    // Run multiple times to increase confidence
    for (let i = 0; i < 20; i++) {
      const phone = generatePhoneNumber();
      expect(phone[0]).not.toBe("0");
    }
  });
});
