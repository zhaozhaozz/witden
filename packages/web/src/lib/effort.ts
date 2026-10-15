/**
 * Reasoning effort choices for a model (the server side is services/effort.ts): the levels its service
 * reported when the model was checked, or else the common levels for its protocol.
 */
import type { Capabilities } from "../api/types";

export const EFFORT_LABEL: Record<string, string> = {
  none: "不思考（none）",
  minimal: "极少（minimal）",
  low: "低（low）",
  medium: "中（medium）",
  high: "高（high）",
  xhigh: "很高（xhigh）",
  max: "最高（max）",
};

const COMMON: Record<string, string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export interface EffortChoices {
  levels: string[];
  /** The levels came from the model's service (otherwise they are the common ones). */
  reported: boolean;
  default: string | null;
}

export function effortChoices(protocol: string | undefined, caps: Capabilities | undefined): EffortChoices {
  const info = caps?.effort;
  if (info && Array.isArray(info.levels)) return { levels: info.levels, reported: true, default: info.default };
  return { levels: COMMON[protocol ?? "openai"] ?? [], reported: false, default: null };
}
