/** Reasoning effort in the console. Which levels a model takes is decided on the server (services/effort.ts). */

export const EFFORT_LABEL: Record<string, string> = {
  none: "不思考（none）",
  minimal: "极少（minimal）",
  low: "低（low）",
  medium: "中（medium）",
  high: "高（high）",
  xhigh: "很高（xhigh）",
  max: "最高（max）",
};

/** A model's levels as the API gives them (`effort` on models and on a role's model). */
export interface EffortChoices {
  levels: string[];
  default: string | null;
  /** service: reported by the model's service; catalog: the model catalog (models.dev); common: the usual levels. */
  source: "service" | "catalog" | "common";
}
