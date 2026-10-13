import { withSpan } from "axiom/ai";
import { axiomEnabled } from "../instrumentation";

/**
 * Executes a function within an Axiom span if instrumentation is enabled.
 * If Axiom is not configured, simply executes the function directly.
 *
 * @param meta - Span metadata including capability and step name
 * @param fn - The function to execute
 */
export async function maybeWithSpan<T>(
  meta: { capability: string; step: string },
  fn: () => Promise<T>,
): Promise<T> {
  return axiomEnabled ? withSpan(meta, async () => fn()) : fn();
}
