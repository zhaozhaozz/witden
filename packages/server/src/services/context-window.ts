/**
 * How much context a model takes, and when a conversation on it is compacted.
 *
 * The window comes from (in order) what an administrator set on the model, what the provider's model list
 * reports, or the model catalog (services/model-catalog.ts: models.dev, the maker's data unless the provider is
 * a third party the catalog knows). A model none of them knows gets a conservative window, so a long
 * conversation is compacted before the service rejects it.
 */
import type { ModelConfig } from "../db/schema.js";
import type { CatalogMatch } from "./model-catalog.js";

export const DEFAULT_WINDOW = 64_000;
/** Compact at three quarters of the window: room for the answer, tool results and the summary request. */
export const COMPACT_RATIO = 0.75;

export interface ContextLimits {
  window: number;
  compactAt: number;
  /** Where the window came from: set on the model, reported by the provider, the model catalog, or a default. */
  source: "model" | "provider" | "catalog" | "default";
}

/** The catalog's window for a model: its prompt limit where the catalog gives one, else its context. */
export function catalogWindow(catalog: CatalogMatch | null | undefined): number | null {
  return catalog ? (catalog.input ?? catalog.context) : null;
}

/**
 * The model's largest answer in tokens: what its service reports (Anthropic's model list), else the model catalog;
 * null when neither knows. The Anthropic protocol sends it as max_tokens unless the model's parameters set one.
 */
export function maxOutputTokens(m: Pick<ModelConfig, "capabilities" | "catalog">): number | null {
  const reported = Number(m.capabilities?.max_output_tokens);
  if (Number.isInteger(reported) && reported > 0) return reported;
  return (m.catalog as CatalogMatch | null)?.output ?? null;
}

export function contextLimits(
  m: Pick<ModelConfig, "contextWindow" | "compactTokens" | "capabilities" | "catalog">,
): ContextLimits {
  const reported = Number(m.capabilities?.context_window);
  const listed = catalogWindow(m.catalog as CatalogMatch | null);
  const [window, source]: [number, ContextLimits["source"]] = m.contextWindow
    ? [m.contextWindow, "model"]
    : Number.isFinite(reported) && reported > 0
      ? [reported, "provider"]
      : listed
        ? [listed, "catalog"]
        : [DEFAULT_WINDOW, "default"];
  const recommended = Math.floor(window * COMPACT_RATIO);
  const compactAt = m.compactTokens ? Math.min(m.compactTokens, window) : recommended;
  return { window, compactAt, source };
}
