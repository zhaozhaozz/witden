/**
 * How much context a model takes, and when a conversation on it is compacted.
 *
 * The window comes from (in order) what an administrator set on the model, what the provider's model list
 * reports, or a recommendation by model family. Families are matched loosely, most specific first; anything
 * unknown gets a conservative window so a long conversation is compacted before the service rejects it.
 */
import type { ModelConfig } from "../db/schema.js";

export const DEFAULT_WINDOW = 64_000;
/** Compact at three quarters of the window: room for the answer, tool results and the summary request. */
export const COMPACT_RATIO = 0.75;

const K = 1000;
const FAMILIES: [RegExp, number][] = [
  [/claude-(3|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2025|sonnet-4-2025)/i, 200 * K],
  [/claude/i, 1_000 * K],
  [/gpt-4\.1/i, 1_000 * K],
  [/gpt-5/i, 400 * K],
  [/(^|\/)o[134](-|$)/i, 200 * K],
  [/gpt-4o|gpt-4-turbo/i, 128 * K],
  [/gpt-3\.5/i, 16 * K],
  [/gemini/i, 1_000 * K],
  [/deepseek/i, 128 * K],
  [/kimi|moonshot/i, 128 * K],
  [/qwen|qwq/i, 128 * K],
  [/glm/i, 128 * K],
  [/llama-?3\.[1-9]|llama-?4/i, 128 * K],
  [/mistral-large|mistral-medium|ministral|codestral/i, 128 * K],
  [/minimax/i, 200 * K],
];

/** The recommended window for a model id, or null when its family is unknown. */
export function recommendedWindow(model: string): number | null {
  for (const [pattern, size] of FAMILIES) if (pattern.test(model)) return size;
  return null;
}

export interface ContextLimits {
  window: number;
  compactAt: number;
  /** Where the window came from: set on the model, reported by the provider, the family table, or a default. */
  source: "model" | "provider" | "family" | "default";
}

export function contextLimits(m: Pick<ModelConfig, "model" | "contextWindow" | "compactTokens" | "capabilities">) {
  const reported = Number(m.capabilities?.context_window);
  const family = recommendedWindow(m.model);
  const [window, source]: [number, ContextLimits["source"]] = m.contextWindow
    ? [m.contextWindow, "model"]
    : Number.isFinite(reported) && reported > 0
      ? [reported, "provider"]
      : family
        ? [family, "family"]
        : [DEFAULT_WINDOW, "default"];
  const recommended = Math.floor(window * COMPACT_RATIO);
  const compactAt = m.compactTokens ? Math.min(m.compactTokens, window) : recommended;
  return { window, compactAt, source } satisfies ContextLimits;
}
