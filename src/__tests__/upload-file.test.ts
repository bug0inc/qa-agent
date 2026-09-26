import { describe, expect, it } from "vitest";
import { resolveCachedUploadPaths, resolveUploadPath } from "../tools";

describe("resolveUploadPath", () => {
  it("returns absolute Unix paths as-is", () => {
    expect(resolveUploadPath("/tmp/file.png", "./uploads")).toBe("/tmp/file.png");
    expect(resolveUploadPath("/var/log/test.pdf", "./uploads")).toBe("/var/log/test.pdf");
  });

  it("returns Windows absolute paths as-is", () => {
    expect(resolveUploadPath("C:\\Users\\test\\file.png", "./uploads")).toBe("C:\\Users\\test\\file.png");
    expect(resolveUploadPath("D:\\data\\document.pdf", "./uploads")).toBe("D:\\data\\document.pdf");
  });

  it("prefixes relative paths with uploadBasePath", () => {
    expect(resolveUploadPath("file.png", "./uploads")).toBe("./uploads/file.png");
    expect(resolveUploadPath("document.pdf", "./uploads")).toBe("./uploads/document.pdf");
  });

  it("uses custom uploadBasePath for relative paths", () => {
    expect(resolveUploadPath("file.png", "/custom/uploads")).toBe("/custom/uploads/file.png");
    expect(resolveUploadPath("test.txt", "uploads")).toBe("uploads/test.txt");
  });

  it("handles mixed arrays correctly", () => {
    const paths = ["/tmp/a.png", "b.pdf", "C:\\data\\c.jpg"];
    const resolved = paths.map((p) => resolveUploadPath(p, "./uploads"));
    expect(resolved).toEqual(["/tmp/a.png", "./uploads/b.pdf", "C:\\data\\c.jpg"]);
  });

  it("handles relative paths with subdirectories", () => {
    expect(resolveUploadPath("folder/file.png", "./uploads")).toBe("./uploads/folder/file.png");
    expect(resolveUploadPath("uploads/test/document.pdf", "./uploads")).toBe("./uploads/uploads/test/document.pdf");
  });
});

describe("cached upload path resolution", () => {
  it("resolves a raw filename coming from step.data", () => {
    expect(resolveCachedUploadPaths("report.pdf", "", "./uploads")).toEqual([
      "./uploads/report.pdf",
    ]);
  });

  it("does not re-prefix the cached value when step.data has no value", () => {
    expect(resolveCachedUploadPaths(undefined, "./uploads/a.pdf,/tmp/b.png", "./uploads")).toEqual([
      "./uploads/a.pdf",
      "/tmp/b.png",
    ]);
  });

  it("prefers step.data over the cached value", () => {
    expect(resolveCachedUploadPaths("fresh.pdf", "./uploads/stale.pdf", "./uploads")).toEqual([
      "./uploads/fresh.pdf",
    ]);
  });

  it("splits multiple raw filenames and skips empty entries", () => {
    expect(resolveCachedUploadPaths("a.pdf, b.png,", "", "./uploads")).toEqual([
      "./uploads/a.pdf",
      "./uploads/b.png",
    ]);
  });

  it("returns an empty list when neither source has a value", () => {
    expect(resolveCachedUploadPaths(undefined, undefined, "./uploads")).toEqual([]);
  });
});
