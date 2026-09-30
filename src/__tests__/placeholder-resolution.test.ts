import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Redis before importing data-cache
vi.mock("../redis", () => ({
  redis: {
    hgetall: vi.fn(),
    hset: vi.fn(),
    expire: vi.fn(),
  },
}));

// Mock email module
vi.mock("../email", () => ({
  extractEmailContent: vi.fn(),
}));

import { redis } from "../redis";
import { resetConfig, configure } from "../config";
import {
  generateLocalValues,
  generateGlobalValues,
  replacePlaceholders,
  processPlaceholders,
  resolveEmailPlaceholders,
  getDynamicEmail,
  getGlobalValues,
  saveGlobalValues,
  getProjectData,
  LocalPlaceholders,
  GlobalPlaceholders,
  EMAIL_EXTRACTION_PATTERN,
} from "../data-cache";
import { extractEmailContent } from "../email";

const mockRedis = redis as any;

beforeEach(() => {
  resetConfig();
  vi.clearAllMocks();
});

afterEach(() => {
  resetConfig();
});

describe("PRIORITY 1 — Placeholder Resolution", () => {
  describe("{{run.*}} placeholder generation", () => {
    it("generates valid {{run.email}} with @ symbol", async () => {
      const values = await generateLocalValues();
      expect(values["{{run.email}}"]).toMatch(/@/);
      expect(values["{{run.email}}"].length).toBeGreaterThan(0);
    });

    it("generates valid {{run.fullName}} with at least first and last name", async () => {
      const values = await generateLocalValues();
      const name = values["{{run.fullName}}"];
      expect(name).toBeTruthy();
      expect(name.length).toBeGreaterThan(0);
      // Should have at least one space (first + last name)
      expect(name).toMatch(/\s/);
    });

    it("generates valid {{run.shortid}} with non-empty string", async () => {
      const values = await generateLocalValues();
      expect(values["{{run.shortid}}"]).toBeTruthy();
      expect(values["{{run.shortid}}"].length).toBeGreaterThan(0);
    });

    it("generates valid {{run.phoneNumber}} with correct format", async () => {
      const values = await generateLocalValues();
      const phone = values["{{run.phoneNumber}}"];
      expect(phone).toBeTruthy();
      // Should be numeric or contain standard phone chars
      expect(phone).toMatch(/^[\d\s()+\-]+$/);
    });

    it("generates {{run.dynamicEmail}} when email provider is configured", async () => {
      configure({
        email: {
          domain: "test.dev",
          extractContent: vi.fn(),
        },
      });

      const values = await generateLocalValues();
      expect(values["{{run.dynamicEmail}}"]).toMatch(/@test\.dev$/);
      expect(values["{{run.dynamicEmail}}"]).toMatch(/^e2e-tester-/);
    });

    it("generates empty {{run.dynamicEmail}} when no email provider is configured", async () => {
      const values = await generateLocalValues();
      expect(values["{{run.dynamicEmail}}"]).toBe("");
    });

    it("generates unique values across multiple calls", async () => {
      const values1 = await generateLocalValues();
      const values2 = await generateLocalValues();

      // Each call should generate different random values
      expect(values1["{{run.shortid}}"]).not.toBe(values2["{{run.shortid}}"]);
      expect(values1["{{run.email}}"]).not.toBe(values2["{{run.email}}"]);
    });
  });

  describe("{{global.*}} placeholder persistence across executionIds", () => {
    it("generates fresh global values when no cached values exist", async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const globalValues = await generateGlobalValues(null);

      expect(globalValues["{{global.shortid}}"]).toBeTruthy();
      expect(globalValues["{{global.fullName}}"]).toBeTruthy();
      expect(globalValues["{{global.email}}"]).toMatch(/@/);
    });

    it("reuses existing global values when provided", async () => {
      const existingValues = {
        "{{global.shortid}}": "existing-id",
        "{{global.fullName}}": "Existing User",
        "{{global.email}}": "existing@test.com",
        "{{global.dynamicEmail}}": "dyn@test.com",
        "{{global.phoneNumber}}": "1234567890",
      };

      const globalValues = await generateGlobalValues(existingValues);

      expect(globalValues["{{global.shortid}}"]).toBe("existing-id");
      expect(globalValues["{{global.fullName}}"]).toBe("Existing User");
      expect(globalValues["{{global.email}}"]).toBe("existing@test.com");
    });

    it("only generates missing global values from partial existing values", async () => {
      const partialValues = {
        "{{global.email}}": "preserved@test.com",
      };

      const globalValues = await generateGlobalValues(partialValues as any);

      expect(globalValues["{{global.email}}"]).toBe("preserved@test.com");
      expect(globalValues["{{global.shortid}}"]).toBeTruthy();
      expect(globalValues["{{global.fullName}}"]).toBeTruthy();
    });

    it("saves global values to Redis with correct TTL", async () => {
      const executionId = "test-exec-123";
      const values: GlobalPlaceholders = {
        "{{global.shortid}}": "abc123",
        "{{global.fullName}}": "Test User",
        "{{global.email}}": "test@example.com",
        "{{global.dynamicEmail}}": "dyn@test.com",
        "{{global.phoneNumber}}": "1234567890",
      };

      await saveGlobalValues(executionId, values);

      expect(mockRedis.hset).toHaveBeenCalledWith(
        `execution:${executionId}:globals`,
        values
      );
      expect(mockRedis.expire).toHaveBeenCalledWith(
        `execution:${executionId}:globals`,
        86400 // GLOBAL_VALUES_TTL_SECONDS
      );
    });

    it("loads global values from Redis for existing executionId", async () => {
      const executionId = "test-exec-456";
      const storedValues = {
        "{{global.shortid}}": "stored-id",
        "{{global.email}}": "stored@test.com",
      };

      mockRedis.hgetall.mockResolvedValue(storedValues);

      const result = await getGlobalValues(executionId);

      expect(mockRedis.hgetall).toHaveBeenCalledWith(`execution:${executionId}:globals`);
      expect(result).toEqual(storedValues);
    });

    it("returns null when no global values exist in Redis", async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await getGlobalValues("non-existent-exec");

      expect(result).toBeNull();
    });

    it("shares global values across multiple runSteps calls with same executionId", async () => {
      const executionId = "shared-exec";

      configure({
        email: {
          domain: "test.dev",
          extractContent: vi.fn(),
        },
      });

      // First call - generates and saves new values
      mockRedis.hgetall.mockResolvedValueOnce({});

      const result1 = await processPlaceholders(
        [{ description: "Step using {{global.email}}" }],
        undefined,
        executionId
      );

      // Capture what was saved
      const savedValues = mockRedis.hset.mock.calls[0][1];

      // Second call - loads previously saved values
      mockRedis.hgetall.mockResolvedValueOnce(savedValues);

      const result2 = await processPlaceholders(
        [{ description: "Another step using {{global.email}}" }],
        undefined,
        executionId
      );

      // Both calls should use the same global values
      expect(result1.globalValues).toEqual(result2.globalValues);
    });

    it("does NOT share global values across different executionIds", async () => {
      configure({
        email: {
          domain: "test.dev",
          extractContent: vi.fn(),
        },
      });

      mockRedis.hgetall.mockResolvedValue({});

      const result1 = await processPlaceholders(
        [{ description: "Step 1" }],
        undefined,
        "exec-1"
      );

      const result2 = await processPlaceholders(
        [{ description: "Step 2" }],
        undefined,
        "exec-2"
      );

      // Different executionIds should have different global values
      expect(result1.globalValues?.["{{global.shortid}}"]).not.toBe(
        result2.globalValues?.["{{global.shortid}}"]
      );
    });
  });

  describe("{{data.*}} placeholder resolution from Redis", () => {
    it("resolves {{data.username}} from project data", async () => {
      const projectData = {
        username: "admin",
        password: "secret123",
      };

      mockRedis.hgetall.mockResolvedValue(projectData);

      const result = await getProjectData("project-123");

      expect(result).toEqual(projectData);
      expect(mockRedis.hgetall).toHaveBeenCalledWith("project:project-123:data");
    });

    it("returns empty object when no project data exists", async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await getProjectData("non-existent-project");

      expect(result).toEqual({});
    });

    it("replaces {{data.key}} placeholders in step data", async () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      const projectData = {
        apiKey: "test-api-key-123",
        username: "testuser",
      };

      const result = replacePlaceholders(
        "Use {{data.apiKey}} to authenticate as {{data.username}}",
        localValues,
        undefined,
        projectData
      );

      expect(result).toBe("Use test-api-key-123 to authenticate as testuser");
    });

    it("processes {{data.*}} placeholders in processPlaceholders", async () => {
      mockRedis.hgetall.mockResolvedValue({
        apiUrl: "https://api.example.com",
      });

      const result = await processPlaceholders(
        [
          {
            description: "Navigate to {{data.apiUrl}}",
            data: { url: "{{data.apiUrl}}" },
          },
        ],
        undefined,
        undefined,
        "project-123"
      );

      expect(result.processedSteps[0].data?.url).toBe("https://api.example.com");
    });

    it("warns and keeps placeholder when {{data.key}} not found", async () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      const projectData = { existingKey: "value" };

      const result = replacePlaceholders(
        "Using {{data.missingKey}}",
        localValues,
        undefined,
        projectData
      );

      // Placeholder should remain unchanged when not found
      expect(result).toBe("Using {{data.missingKey}}");
    });
  });

  describe("{{email.*}} placeholder lazy resolution", () => {
    it("matches email extraction pattern correctly", () => {
      const match1 = "{{email.otp:get the 6 digit code}}".match(EMAIL_EXTRACTION_PATTERN);
      expect(match1).toBeTruthy();
      expect(match1![1]).toBe("otp");
      expect(match1![2]).toBe("get the 6 digit code");

      const match2 = "{{email.link:extract the verification link:custom@test.com}}".match(
        EMAIL_EXTRACTION_PATTERN
      );
      expect(match2).toBeTruthy();
      expect(match2![1]).toBe("link");
      expect(match2![2]).toBe("extract the verification link");
      expect(match2![3]).toBe("custom@test.com");
    });

    it("resolves email placeholder using provider's extractContent", async () => {
      const mockExtractContent = vi.fn().mockResolvedValue("123456");
      configure({
        email: {
          domain: "test.dev",
          extractContent: mockExtractContent,
        },
      });

      vi.mocked(extractEmailContent).mockResolvedValue("123456");

      const step = {
        description: "Enter OTP",
        data: {
          value: "{{email.otp:get the 6 digit verification code}}",
        },
      };

      const result = await resolveEmailPlaceholders(step, "test@test.dev");

      expect(extractEmailContent).toHaveBeenCalledWith({
        email: "test@test.dev",
        prompt: "get the 6 digit verification code",
      });
      expect(result.data?.value).toBe("123456");
    });

    it("uses explicit email when provided in placeholder", async () => {
      vi.mocked(extractEmailContent).mockResolvedValue("extracted-value");

      configure({
        email: {
          domain: "test.dev",
          extractContent: vi.fn(),
        },
      });

      const step = {
        description: "Get code",
        data: {
          value: "{{email.code:get code:explicit@email.com}}",
        },
      };

      const result = await resolveEmailPlaceholders(step, "default@test.dev");

      expect(extractEmailContent).toHaveBeenCalledWith({
        email: "explicit@email.com",
        prompt: "get code",
      });
    });

    it("uses dynamicEmail when no explicit email provided", async () => {
      vi.mocked(extractEmailContent).mockResolvedValue("link-value");

      configure({
        email: {
          domain: "test.dev",
          extractContent: vi.fn(),
        },
      });

      const step = {
        description: "Get link",
        data: {
          value: "{{email.link:extract magic link}}",
        },
      };

      const result = await resolveEmailPlaceholders(step, "dynamic@test.dev");

      expect(extractEmailContent).toHaveBeenCalledWith({
        email: "dynamic@test.dev",
        prompt: "extract magic link",
      });
    });

    it("getDynamicEmail prefers global over local", () => {
      const local: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "local@test.dev",
        "{{run.phoneNumber}}": "123",
      };

      const global: GlobalPlaceholders = {
        "{{global.shortid}}": "xyz",
        "{{global.fullName}}": "Jane",
        "{{global.email}}": "jane@test.com",
        "{{global.dynamicEmail}}": "global@test.dev",
        "{{global.phoneNumber}}": "456",
      };

      expect(getDynamicEmail(local, global)).toBe("global@test.dev");
    });

    it("getDynamicEmail falls back to local when no global", () => {
      const local: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "local@test.dev",
        "{{run.phoneNumber}}": "123",
      };

      expect(getDynamicEmail(local, undefined)).toBe("local@test.dev");
    });
  });

  describe("Malformed placeholder handling", () => {
    it("handles unclosed braces gracefully", () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      const result = replacePlaceholders(
        "Text with {{run.email unclosed",
        localValues
      );

      // Should not crash, returns text as-is
      expect(result).toBe("Text with {{run.email unclosed");
    });

    it("handles unknown placeholder keys gracefully", () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      const result = replacePlaceholders(
        "Using {{run.unknownKey}}",
        localValues
      );

      // Unknown placeholders remain unreplaced
      expect(result).toBe("Using {{run.unknownKey}}");
    });

    it("handles nested placeholders gracefully", () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      const result = replacePlaceholders(
        "Nested {{run.{{run.email}}}}",
        localValues
      );

      // Should not crash
      expect(result).toBeTruthy();
    });

    it("throws ValidationError when using {{global.*}} without executionId", async () => {
      await expect(
        processPlaceholders(
          [{ description: "Step with {{global.email}}" }],
          undefined,
          undefined // no executionId
        )
      ).rejects.toThrow("{{global.*}} placeholders require an executionId");
    });

    it("throws ValidationError when using {{data.*}} without projectId", async () => {
      await expect(
        processPlaceholders(
          [{ description: "Step with {{data.apiKey}}" }],
          undefined,
          undefined,
          undefined // no projectId
        )
      ).rejects.toThrow("{{data.*}} placeholders require a projectId");
    });

    it("throws ConfigurationError when using {{run.dynamicEmail}} without email config", () => {
      const localValues: LocalPlaceholders = {
        "{{run.shortid}}": "abc",
        "{{run.fullName}}": "John",
        "{{run.email}}": "john@test.com",
        "{{run.dynamicEmail}}": "dyn@test.com",
        "{{run.phoneNumber}}": "123",
      };

      expect(() =>
        replacePlaceholders("Email: {{run.dynamicEmail}}", localValues)
      ).toThrow("Email provider not configured");
    });
  });
});
