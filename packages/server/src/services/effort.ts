/**
 * Reasoning effort: how much a role's model thinks before it answers. Services use the same level names but
 * take them in different places, and some report which levels each model accepts:
 *
 * - Anthropic: `output_config.effort`; `GET /v1/models` reports `capabilities.effort.<level>.supported`.
 * - OpenRouter-style gateways: `reasoning.effort`; their model list reports `reasoning.supported_efforts`.
 * - Other OpenAI-compatible services (OpenAI, vLLM, Ollama, ...): `reasoning_effort`; nothing reported, so the
 *   common levels are offered and the service decides.
 */
export const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What a service reported about a model's effort, kept in the model's capabilities (`capabilities.effort`). */
export interface EffortInfo {
  /** Levels the model accepts, lowest first; empty when it has no effort setting. */
  levels: string[];
  /** The model's own default level, when reported. */
  default: string | null;
  /** Where requests carry the level. */
  param: "output_config" | "reasoning" | "reasoning_effort";
}

/** Levels offered when the service reports nothing; a model may still refuse some of them. */
export const COMMON_EFFORTS: Record<string, string[]> = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

const ordered = (levels: string[]) => EFFORT_LEVELS.filter((l) => levels.includes(l));

/** An Anthropic model object (`GET /v1/models`): `capabilities.effort`. */
export function anthropicEffort(model: any): EffortInfo | undefined {
  const effort = model?.capabilities?.effort;
  if (!effort || typeof effort !== "object") return undefined;
  const levels = effort.supported === false ? [] : EFFORT_LEVELS.filter((l) => effort[l]?.supported === true);
  return { levels, default: null, param: "output_config" };
}

/** An OpenRouter-style model entry: `reasoning.supported_efforts` (null: any), `default_effort`, `mandatory`. */
export function gatewayEffort(model: any): EffortInfo | undefined {
  const r = model?.reasoning;
  if (!r || typeof r !== "object") return undefined;
  let levels = Array.isArray(r.supported_efforts) ? ordered(r.supported_efforts.map(String)) : COMMON_EFFORTS.openai;
  // Reasoning that cannot be switched off has no "none".
  if (r.mandatory) levels = levels.filter((l) => l !== "none");
  return { levels, default: typeof r.default_effort === "string" ? r.default_effort : null, param: "reasoning" };
}

/** The levels a role may pick for a model, and whether they came from the service. */
export function effortChoices(protocol: string, capabilities: Record<string, any> | null | undefined) {
  const info = capabilities?.effort as EffortInfo | null | undefined;
  if (info && Array.isArray(info.levels)) return { levels: info.levels, reported: true };
  return { levels: COMMON_EFFORTS[protocol] ?? [], reported: false };
}

/** Request parameters with the level in the place the service takes it. */
export function withEffort(
  protocol: string,
  capabilities: Record<string, any> | null | undefined,
  effort: string,
  params: Record<string, any>,
): Record<string, any> {
  const param =
    (capabilities?.effort as EffortInfo | null | undefined)?.param ??
    (protocol === "anthropic" ? "output_config" : "reasoning_effort");
  if (param === "output_config") return { ...params, output_config: { ...(params.output_config ?? {}), effort } };
  if (param === "reasoning") return { ...params, reasoning: { ...(params.reasoning ?? {}), effort } };
  return { ...params, reasoning_effort: effort };
}
