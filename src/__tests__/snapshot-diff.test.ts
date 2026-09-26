import { describe, it, expect } from "vitest";
import { computeSnapshotDiff } from "../utils/snapshot-diff";

// 200-line snapshot large enough for the 20% savings threshold to be met on small diffs
const makeSnapshot = (lines: string[]) => lines.join("\n");
const BASE_LINES = Array.from({ length: 200 }, (_, i) => `  row: "Item ${i}"`);
const LARGE_SNAPSHOT = makeSnapshot(BASE_LINES);

describe("computeSnapshotDiff", () => {
  it("returns unchanged message when snapshots are identical", () => {
    const { diff, isFull, savedChars } = computeSnapshotDiff(LARGE_SNAPSHOT, LARGE_SNAPSHOT);
    expect(diff).toBe("[snapshot unchanged — action may not have had a visible DOM effect]");
    expect(isFull).toBe(false);
    expect(savedChars).toBe(LARGE_SNAPSHOT.length);
  });

  it("identical after trimming whitespace is treated as unchanged", () => {
    const snap = `${LARGE_SNAPSHOT}   `;
    const { diff } = computeSnapshotDiff(snap, snap);
    expect(diff).toBe("[snapshot unchanged — action may not have had a visible DOM effect]");
  });

  it("returns a diff with + and - prefixes for a single-line change", () => {
    const afterLines = [...BASE_LINES];
    afterLines[100] = '  checkbox [checked] "Select Item 100"';
    const after = makeSnapshot(afterLines);

    const { diff, isFull } = computeSnapshotDiff(LARGE_SNAPSHOT, after);

    expect(isFull).toBe(false);
    expect(diff).toContain('- ' + BASE_LINES[100]);
    expect(diff).toContain('+ ' + afterLines[100]);
  });

  it("includes a header with added/removed counts", () => {
    const afterLines = [...BASE_LINES];
    afterLines[50] = '  row: "Changed Item 50"';
    const after = makeSnapshot(afterLines);

    const { diff } = computeSnapshotDiff(LARGE_SNAPSHOT, after);

    expect(diff).toMatch(/\[delta snapshot: \+\d+ lines added, -\d+ lines removed\]/);
  });

  it("includes context lines around changes", () => {
    const afterLines = [...BASE_LINES];
    afterLines[50] = '  row: "Modified"';
    const after = makeSnapshot(afterLines);

    const { diff } = computeSnapshotDiff(LARGE_SNAPSHOT, after);

    // 2 lines of context on each side of the changed line
    expect(diff).toContain(`  ${BASE_LINES[48]}`);
    expect(diff).toContain(`  ${BASE_LINES[49]}`);
    expect(diff).toContain(`  ${BASE_LINES[51]}`);
    expect(diff).toContain(`  ${BASE_LINES[52]}`);
  });

  it("uses '...' separators for skipped lines far from any change", () => {
    const afterLines = [...BASE_LINES];
    afterLines[100] = '  row: "Changed"';
    const after = makeSnapshot(afterLines);

    const { diff } = computeSnapshotDiff(LARGE_SNAPSHOT, after);

    expect(diff).toContain("...");
  });

  it("falls back to full snapshot when savings ratio is below threshold", () => {
    // Completely different content — diff would be larger than the 20% savings threshold
    const after = Array.from({ length: 200 }, (_, i) => `  row: "Different ${i}"`).join("\n");
    const { diff, isFull, savedChars } = computeSnapshotDiff(LARGE_SNAPSHOT, after);
    expect(isFull).toBe(true);
    expect(savedChars).toBe(0);
    expect(diff).toBe(after);
  });

  it("returns diff (not full) when change is small relative to snapshot size", () => {
    const afterLines = [...BASE_LINES];
    afterLines[100] = '  row: "Modified Item 100"';
    const after = makeSnapshot(afterLines);

    const { isFull, savedChars } = computeSnapshotDiff(LARGE_SNAPSHOT, after);
    expect(isFull).toBe(false);
    expect(savedChars).toBeGreaterThan(0);
  });

  it("handles lines being added (new row appearing)", () => {
    const afterLines = [...BASE_LINES];
    afterLines.splice(100, 0, '  row: "NEW ITEM"');
    const after = makeSnapshot(afterLines);

    const { diff, isFull } = computeSnapshotDiff(LARGE_SNAPSHOT, after);
    expect(isFull).toBe(false);
    expect(diff).toContain('+ ' + '  row: "NEW ITEM"');
  });

  it("handles lines being removed (row disappearing)", () => {
    const afterLines = [...BASE_LINES];
    afterLines.splice(100, 1);
    const after = makeSnapshot(afterLines);

    const { diff, isFull } = computeSnapshotDiff(LARGE_SNAPSHOT, after);
    expect(isFull).toBe(false);
    expect(diff).toContain('- ' + BASE_LINES[100]);
  });

  it("savedChars equals after.length minus diff.length when not full", () => {
    const afterLines = [...BASE_LINES];
    afterLines[10] = '  row: "Changed Item 10"';
    const after = makeSnapshot(afterLines);

    const { diff, isFull, savedChars } = computeSnapshotDiff(LARGE_SNAPSHOT, after);
    expect(isFull).toBe(false);
    expect(savedChars).toBe(after.length - diff.length);
  });
});
