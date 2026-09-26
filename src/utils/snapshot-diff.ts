import { DELTA_SNAPSHOT_MIN_SAVINGS_RATIO } from "../constants";

/**
 * Computes a human-readable structural diff between two ariaSnapshot strings.
 *
 * Returns a compact diff showing added/removed lines with 2 lines of context.
 * Falls back to the full snapshot if the diff would not save at least
 * DELTA_SNAPSHOT_MIN_SAVINGS_RATIO of the original size — delta mode is
 * never worse than full mode.
 */
export function computeSnapshotDiff(
  before: string,
  after: string,
): { diff: string; isFull: boolean; savedChars: number } {
  if (before.trim() === after.trim()) {
    return {
      diff: "[snapshot unchanged — action may not have had a visible DOM effect]",
      isFull: false,
      savedChars: after.length,
    };
  }

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  const diff = computeLineDiff(beforeLines, afterLines);
  const contextLines = 2;

  const changedIndices = new Set<number>();
  diff.forEach((entry, i) => {
    if (entry.type !== "equal") {
      for (
        let c = Math.max(0, i - contextLines);
        c <= Math.min(diff.length - 1, i + contextLines);
        c++
      ) {
        changedIndices.add(c);
      }
    }
  });

  const output: string[] = [];
  let prevWasGap = false;
  let addedLines = 0;
  let removedLines = 0;

  diff.forEach((entry, i) => {
    if (!changedIndices.has(i)) {
      if (!prevWasGap) {
        output.push("...");
        prevWasGap = true;
      }
      return;
    }
    prevWasGap = false;

    if (entry.type === "add") {
      output.push(`+ ${entry.line}`);
      addedLines++;
    } else if (entry.type === "remove") {
      output.push(`- ${entry.line}`);
      removedLines++;
    } else {
      output.push(`  ${entry.line}`);
    }
  });

  const header = `[delta snapshot: +${addedLines} lines added, -${removedLines} lines removed]\n\n`;
  const diffStr = header + output.join("\n");

  const savedChars = after.length - diffStr.length;
  const savingsRatio = savedChars / after.length;

  if (savingsRatio < DELTA_SNAPSHOT_MIN_SAVINGS_RATIO) {
    return { diff: after, isFull: true, savedChars: 0 };
  }

  return { diff: diffStr, isFull: false, savedChars };
}

type DiffEntry = { type: "equal" | "add" | "remove"; line: string };

function computeLineDiff(before: string[], after: string[]): DiffEntry[] {
  const result: DiffEntry[] = [];
  let i = 0,
    j = 0;

  const afterIndex = new Map<string, number[]>();
  after.forEach((line, idx) => {
    if (!afterIndex.has(line)) afterIndex.set(line, []);
    afterIndex.get(line)!.push(idx);
  });

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      result.push({ type: "equal", line: before[i] });
      i++;
      j++;
    } else {
      const nextInAfter = (afterIndex.get(before[i]) ?? []).find((idx) => idx >= j);
      const nextInBefore = before.findIndex((l, idx) => idx > i && l === after[j]);

      const distToAfterMatch = nextInAfter !== undefined ? nextInAfter - j : Infinity;
      const distToBeforeMatch = nextInBefore !== -1 ? nextInBefore - i : Infinity;

      if (distToAfterMatch <= distToBeforeMatch && nextInAfter !== undefined) {
        while (j < nextInAfter) {
          result.push({ type: "add", line: after[j] });
          j++;
        }
      } else if (nextInBefore !== -1) {
        while (i < nextInBefore) {
          result.push({ type: "remove", line: before[i] });
          i++;
        }
      } else {
        result.push({ type: "remove", line: before[i] });
        result.push({ type: "add", line: after[j] });
        i++;
        j++;
      }
    }
  }

  while (i < before.length) {
    result.push({ type: "remove", line: before[i++] });
  }
  while (j < after.length) {
    result.push({ type: "add", line: after[j++] });
  }

  return result;
}
