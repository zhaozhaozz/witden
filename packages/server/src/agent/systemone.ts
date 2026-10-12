/**
 * System One decision models: TypeSafe Jev and the open-source Laya, which serves the same wire protocol.
 * They do not chat or generate text. One request carries a ``state`` (the content to judge) and named, typed
 * questions about it; each answer comes back with probabilities in a single fast pass:
 *
 *   POST {base}/v1/systemone  {model, state, questions: {name: {type: choice|noul|score, instructions, criteria}}}
 *   -> {model, answers: {name: {type, choice|noul|score, probabilities, confidence}}, usage: {input_tokens, output_tokens}}
 *
 * Jev also lists its models at ``GET {base}/v1/models``; a self-hosted Laya server does not (models are entered
 * by name: multilingual, english, typed-decisions).
 */
import { ModelError } from "../errors.js";
import { request } from "./llm.js";

export type Question =
  | { type: "choice"; instructions?: unknown; criteria: Record<string, unknown> }
  | { type: "noul"; instructions?: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "score"; instructions?: unknown; criteria: unknown[] };

export interface Answer {
  type: string;
  /** choice: the most likely option. */
  choice?: string;
  /** noul: probability of yes. */
  noul?: number;
  /** score: probability-weighted level. */
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface Decision {
  /** The model version that answered. */
  model: string;
  answers: Record<string, Answer>;
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionModel {
  decide(state: unknown, questions: Record<string, Question>): Promise<Decision>;
}

/** The provider address without a trailing slash or "/v1" (people paste either form). */
export const systemOneBase = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

export class SystemOneModel implements DecisionModel {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(
    baseUrl: string,
    private readonly model: string,
    apiKey: string | null,
    /** Extra body fields, e.g. Laya's ``max_len`` or ``lang``. */
    private readonly params: Record<string, any>,
    private readonly timeoutMs = 30_000,
  ) {
    this.url = `${systemOneBase(baseUrl)}/v1/systemone`;
    // A self-hosted Laya without LAYA_API_KEY takes no key.
    this.headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }

  async decide(state: unknown, questions: Record<string, Question>): Promise<Decision> {
    const body = { ...this.params, model: this.model, state, questions };
    const data = await request(
      this.url,
      { method: "POST", headers: this.headers, body: JSON.stringify(body) },
      this.timeoutMs,
    );
    if (!data || typeof data.answers !== "object" || !data.answers)
      throw new ModelError("the decision model returned no answers");
    for (const name of Object.keys(questions)) {
      if (!data.answers[name]) throw new ModelError(`the decision model did not answer ${JSON.stringify(name)}`);
    }
    return {
      model: String(data.model ?? this.model),
      answers: data.answers,
      inputTokens: Number(data.usage?.input_tokens ?? 0) || 0,
      outputTokens: Number(data.usage?.output_tokens ?? 0) || 0,
    };
  }
}

/** One question with an obvious answer: checks the connection and measures the response time. */
export async function probeDecisionModel(model: DecisionModel): Promise<Record<string, any>> {
  const caps: Record<string, any> = { checked_at: new Date().toISOString(), errors: {} };
  try {
    const started = Date.now();
    const res = await model.decide("I was charged twice for this month's invoice. Please refund one payment.", {
      team: {
        type: "choice",
        instructions: "Which team should handle this message?",
        criteria: { billing: "payments, invoices and refunds", tech: "bugs, crashes and login problems" },
      },
    });
    caps.latency_ms = Date.now() - started;
    const answer = res.answers.team;
    caps.decide = answer?.choice === "billing";
    if (!caps.decide)
      caps.errors.decide = `answered ${JSON.stringify(answer?.choice ?? null)} to a question whose answer is "billing"`;
  } catch (err) {
    caps.decide = false;
    caps.errors.decide = (err as Error).message;
  }
  return caps;
}
