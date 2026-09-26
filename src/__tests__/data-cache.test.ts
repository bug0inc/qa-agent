import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../redis", () => ({
  getRedis: () => ({
    hgetall: vi.fn().mockResolvedValue({}),
    hset: vi.fn().mockResolvedValue("OK"),
    expire: vi.fn().mockResolvedValue(1),
  }),
  resetRedis: vi.fn(),
  redisHGetAll: vi.fn().mockResolvedValue({}),
  redisHSet: vi.fn().mockResolvedValue(true),
  redisExpire: vi.fn().mockResolvedValue(true),
}));

vi.mock("../email", () => ({
  extractEmailContent: vi.fn(),
}));

import { resetConfig, configure } from "../config";
import {
  containsGlobalPlaceholder,
  stepsContainGlobalPlaceholders,
  replacePlaceholders,
  generateLocalValues,
  getDynamicEmail,
  LocalPlaceholders,
  GlobalPlaceholders,
} from "../data-cache";

const localValues: LocalPlaceholders = {
  "{{run.shortid}}": "abc123",
  "{{run.fullName}}": "John Doe",
  "{{run.email}}": "john@test.com",
  "{{run.dynamicEmail}}": "dyn@test.com",
  "{{run.phoneNumber}}": "1234567890",
};

beforeEach(() => {
  resetConfig();
});

// ─── containsGlobalPlaceholder ──────────────────────────────────────────────

describe("containsGlobalPlaceholder", () => {
  it("returns true for text with a global placeholder", () => {
    expect(containsGlobalPlaceholder("Hello {{global.email}}")).toBe(true);
  });

  it("returns false for text with only a run placeholder", () => {
    expect(containsGlobalPlaceholder("Hello {{run.email}}")).toBe(false);
  });

  it("returns false for text with no placeholders", () => {
    expect(containsGlobalPlaceholder("Hello world")).toBe(false);
  });
});

// ─── stepsContainGlobalPlaceholders ─────────────────────────────────────────

describe("stepsContainGlobalPlaceholders", () => {
  it("returns true when description contains a global placeholder", () => {
    const steps = [{ description: "Enter {{global.email}}" }];
    expect(stepsContainGlobalPlaceholders(steps)).toBe(true);
  });

  it("returns true when data value contains a global placeholder", () => {
    const steps = [
      {
        description: "Fill form",
        data: { email: "{{global.email}}" },
      },
    ];
    expect(stepsContainGlobalPlaceholders(steps)).toBe(true);
  });

  it("returns true when script contains a global placeholder", () => {
    const steps = [
      {
        description: "Run script",
        script: "console.log('{{global.shortid}}')",
      },
    ];
    expect(stepsContainGlobalPlaceholders(steps)).toBe(true);
  });

  it("returns false when no steps contain global placeholders", () => {
    const steps = [
      {
        description: "Enter {{run.email}}",
        data: { name: "{{run.fullName}}" },
        script: "return true;",
      },
    ];
    expect(stepsContainGlobalPlaceholders(steps)).toBe(false);
  });
});

// ─── replacePlaceholders ────────────────────────────────────────────────────

describe("replacePlaceholders", () => {
  it("replaces run placeholders", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const result = replacePlaceholders("User: {{run.fullName}}", localValues);
    expect(result).toBe("User: John Doe");
  });

  it("replaces global placeholders", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const globalValues: GlobalPlaceholders = {
      "{{global.shortid}}": "glob123",
      "{{global.fullName}}": "Jane Global",
      "{{global.email}}": "jane@global.com",
      "{{global.dynamicEmail}}": "dyn@global.com",
      "{{global.phoneNumber}}": "9876543210",
    };
    const result = replacePlaceholders("Email: {{global.email}}", localValues, globalValues);
    expect(result).toBe("Email: jane@global.com");
  });

  it("replaces data placeholders", () => {
    const projectData = { username: "admin", password: "secret" };
    const result = replacePlaceholders(
      "Login as {{data.username}}",
      localValues,
      undefined,
      projectData,
    );
    expect(result).toBe("Login as admin");
  });

  it("handles multiple placeholders in one string", () => {
    configure({ email: { domain: "test.com", extractContent: vi.fn() } });
    const result = replacePlaceholders("{{run.fullName}} <{{run.email}}>", localValues);
    expect(result).toBe("John Doe <john@test.com>");
  });

  it("throws when {{run.dynamicEmail}} is used without email config", () => {
    // resetConfig already called in beforeEach, so no email provider
    expect(() => replacePlaceholders("Send to {{run.dynamicEmail}}", localValues)).toThrow(
      "Email provider not configured",
    );
  });
});

// ─── generateLocalValues ────────────────────────────────────────────────────

describe("generateLocalValues", () => {
  it("returns all 5 placeholder keys", async () => {
    const values = await generateLocalValues();
    expect(values).toHaveProperty("{{run.shortid}}");
    expect(values).toHaveProperty("{{run.fullName}}");
    expect(values).toHaveProperty("{{run.email}}");
    expect(values).toHaveProperty("{{run.dynamicEmail}}");
    expect(values).toHaveProperty("{{run.phoneNumber}}");
  });

  it("returns empty string for dynamicEmail when no email configured", async () => {
    const values = await generateLocalValues();
    expect(values["{{run.dynamicEmail}}"]).toBe("");
  });
});

// ─── getDynamicEmail ────────────────────────────────────────────────────────

describe("getDynamicEmail", () => {
  const globalValues: GlobalPlaceholders = {
    "{{global.shortid}}": "g1",
    "{{global.fullName}}": "Global User",
    "{{global.email}}": "g@test.com",
    "{{global.dynamicEmail}}": "global-dyn@test.com",
    "{{global.phoneNumber}}": "0000000000",
  };

  it("returns global dynamicEmail when preferGlobal=true", () => {
    expect(getDynamicEmail(localValues, globalValues, true)).toBe("global-dyn@test.com");
  });

  it("returns local dynamicEmail when preferGlobal=false even if global is set", () => {
    expect(getDynamicEmail(localValues, globalValues, false)).toBe("dyn@test.com");
  });

  it("returns local dynamicEmail when preferGlobal defaults to false", () => {
    expect(getDynamicEmail(localValues, globalValues)).toBe("dyn@test.com");
  });

  it("falls back to local dynamicEmail when global is not provided", () => {
    expect(getDynamicEmail(localValues)).toBe("dyn@test.com");
  });
});
