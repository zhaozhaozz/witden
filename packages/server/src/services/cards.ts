/**
 * Cards: a message that is more than text. A card is a tree of blocks (text, fields, tables, charts, lists,
 * progress, tabs, form inputs) and buttons, posted by a role (post_card) and kept on the message
 * (``messages.card``: ``{spec, state}``). People act on it in the console or in Feishu (a Feishu card,
 * integrations/feishu-cards.ts): a button, with the form's values, is recorded on the card and reaches the role
 * that posted it as a message (applyCardAction); the role can change the card at any time (update_card).
 *
 * Every card also reads as Markdown (cardMarkdown): that is the message's text, so Slack, GitHub, search and the
 * roles' own context see it without knowing cards.
 */
import { z } from "zod";

const name = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, "lower-case letters, digits and _, starting with a letter (at most 32)");
const short = z.string().trim().min(1).max(200);
const long = z.string().max(4000);
const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);

const inputBlock = z
  .object({
    type: z.literal("input"),
    name,
    label: short,
    kind: z.enum(["text", "textarea", "number", "date", "select", "multiselect", "checkbox"]).default("text"),
    options: z
      .array(z.object({ value: z.string().min(1).max(100), label: short }))
      .max(30)
      .optional(),
    required: z.boolean().optional(),
    placeholder: z.string().max(200).optional(),
    default: z.union([z.string().max(2000), z.number(), z.boolean(), z.array(z.string().max(100))]).optional(),
  })
  .refine((b) => !["select", "multiselect"].includes(b.kind) || (b.options?.length ?? 0) > 0, {
    message: "a select needs options",
  });

const leafBlocks = [
  z.object({ type: z.literal("text"), text: long }),
  z.object({
    type: z.literal("fields"),
    items: z
      .array(z.object({ label: short, value: z.string().max(1000) }))
      .min(1)
      .max(24),
  }),
  z.object({
    type: z.literal("table"),
    columns: z
      .array(
        z.object({
          key: z.string().min(1).max(40),
          label: short,
          align: z.enum(["left", "center", "right"]).optional(),
        }),
      )
      .min(1)
      .max(12),
    rows: z.array(z.record(cell)).max(100),
  }),
  z.object({
    type: z.literal("chart"),
    kind: z.enum(["bar", "line", "pie"]),
    title: z.string().max(200).optional(),
    labels: z.array(z.string().max(60)).min(1).max(50),
    series: z
      .array(z.object({ name: z.string().max(60), values: z.array(z.number().finite()).max(50) }))
      .min(1)
      .max(6),
    unit: z.string().max(20).optional(),
  }),
  z.object({
    type: z.literal("list"),
    items: z
      .array(z.object({ title: short, subtitle: z.string().max(500).optional(), badge: z.string().max(30).optional() }))
      .min(1)
      .max(50),
  }),
  z.object({
    type: z.literal("progress"),
    label: z.string().max(200).optional(),
    value: z.number().finite().min(0),
    max: z.number().finite().positive().optional(),
  }),
  z.object({ type: z.literal("divider") }),
  inputBlock,
] as const;

const leaf = z.union(leafBlocks);
const block = z.union([
  ...leafBlocks,
  z.object({
    type: z.literal("tabs"),
    tabs: z
      .array(z.object({ label: short, blocks: z.array(leaf).min(1).max(30) }))
      .min(2)
      .max(6),
  }),
]);

export const cardSchema = z
  .object({
    title: z.string().max(200).optional(),
    subtitle: z.string().max(300).optional(),
    color: z.enum(["default", "blue", "green", "orange", "red", "purple", "grey"]).optional(),
    blocks: z.array(block).min(1).max(40),
    actions: z
      .array(
        z.object({
          id: name,
          label: z.string().trim().min(1).max(40),
          style: z.enum(["primary", "default", "danger"]).optional(),
          url: z
            .string()
            .url()
            .regex(/^https?:\/\//, "links must be http(s)")
            .optional(),
        }),
      )
      .max(6)
      .optional(),
    /** One answer only: after the first action the buttons are closed. */
    once: z.boolean().optional(),
  })
  .strict();

export type Card = z.infer<typeof cardSchema>;
export type CardBlock = z.infer<typeof block>;
export type CardInput = z.infer<typeof inputBlock>;

/** What people did on a card, and whether it still takes actions. */
export interface CardState {
  actions: {
    action: string;
    label: string;
    values: Record<string, unknown>;
    user_id: string;
    user_name: string;
    at: string;
    /** Where it was done: the console, or a platform (feishu). */
    via: string;
  }[];
  closed: boolean;
}

export interface StoredCard {
  spec: Card;
  state: CardState;
}

const MAX_CARD_BYTES = 24_000;

/** A card as a role wrote it, checked; the error says what to fix. */
export function parseCard(value: unknown): Card {
  const parsed = cardSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "card"}: ${i.message}`);
    throw new Error(`invalid card — ${first.join("; ")}`);
  }
  const card = parsed.data;
  if (Buffer.byteLength(JSON.stringify(card)) > MAX_CARD_BYTES)
    throw new Error(`invalid card — larger than ${MAX_CARD_BYTES / 1000} KB; shorten it or split it`);
  const inputs = cardInputs(card).map((i) => i.name);
  const dup = inputs.find((n, i) => inputs.indexOf(n) !== i);
  if (dup) throw new Error(`invalid card — two inputs are named ${dup}`);
  const ids = (card.actions ?? []).map((a) => a.id);
  const dupAction = ids.find((n, i) => ids.indexOf(n) !== i);
  if (dupAction) throw new Error(`invalid card — two actions are called ${dupAction}`);
  if (inputs.length && !(card.actions ?? []).some((a) => !a.url))
    throw new Error("invalid card — a card with inputs needs a button (an action without url) to submit them");
  return card;
}

export function cardInputs(card: Card): CardInput[] {
  const out: CardInput[] = [];
  const walk = (blocks: CardBlock[]) => {
    for (const b of blocks)
      if (b.type === "input") out.push(b);
      else if (b.type === "tabs") for (const t of b.tabs) walk(t.blocks as CardBlock[]);
  };
  walk(card.blocks);
  return out;
}

const cellText = (v: unknown) =>
  (v === null || v === undefined ? "" : String(v)).replace(/\|/g, "\\|").replace(/\n/g, " ");

function blockMarkdown(b: CardBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "fields":
      return b.items.map((f) => `**${f.label}**：${f.value}`).join("\n");
    case "table": {
      const head = `| ${b.columns.map((c) => cellText(c.label)).join(" | ")} |`;
      const rule = `| ${b.columns.map((c) => (c.align === "right" ? "---:" : c.align === "center" ? ":---:" : "---")).join(" | ")} |`;
      const rows = b.rows.map((r) => `| ${b.columns.map((c) => cellText(r[c.key])).join(" | ")} |`);
      return [head, rule, ...rows].join("\n");
    }
    case "chart": {
      // a chart reads as its numbers
      const unit = b.unit ? ` (${b.unit})` : "";
      const head = `| ${[b.title ?? "", ...b.series.map((s) => s.name + unit)].map(cellText).join(" | ")} |`;
      const rule = `| ${["---", ...b.series.map(() => "---:")].join(" | ")} |`;
      const rows = b.labels.map(
        (l, i) => `| ${[l, ...b.series.map((s) => s.values[i] ?? "")].map(cellText).join(" | ")} |`,
      );
      return [head, rule, ...rows].join("\n");
    }
    case "list":
      return b.items
        .map((i) => `- **${i.title}**${i.badge ? ` \`${i.badge}\`` : ""}${i.subtitle ? `：${i.subtitle}` : ""}`)
        .join("\n");
    case "progress": {
      const max = b.max ?? 100;
      const pct = Math.round((Math.min(b.value, max) / max) * 100);
      return `${b.label ? `${b.label}：` : ""}${"▓".repeat(Math.round(pct / 10))}${"░".repeat(10 - Math.round(pct / 10))} ${pct}%`;
    }
    case "divider":
      return "---";
    case "tabs":
      return b.tabs
        .map((t) => `**${t.label}**\n\n${t.blocks.map((x) => blockMarkdown(x as CardBlock)).join("\n\n")}`)
        .join("\n\n");
    case "input":
      return `*（表单：${b.label}${b.required ? "，必填" : ""}）*`;
  }
}

/** The card as Markdown: its text everywhere cards are not shown, and what roles read. */
export function cardMarkdown(card: Card, state?: CardState): string {
  const parts: string[] = [];
  if (card.title) parts.push(`**${card.title}**${card.subtitle ? `\n${card.subtitle}` : ""}`);
  for (const b of card.blocks) parts.push(blockMarkdown(b));
  const links = (card.actions ?? []).filter((a) => a.url).map((a) => `[${a.label}](${a.url})`);
  const buttons = (card.actions ?? []).filter((a) => !a.url).map((a) => `「${a.label}」`);
  if (links.length) parts.push(links.join(" · "));
  if (buttons.length && !state?.closed)
    parts.push(`*可以在控制台${buttons.length ? "或飞书" : ""}中点击：${buttons.join(" ")}*`);
  for (const a of state?.actions ?? []) parts.push(`*${a.user_name} 选择了「${a.label}」*`);
  return parts.filter(Boolean).join("\n\n");
}

/** For roles: the card's buttons and inputs by id, appended to what they read of the message. */
export function cardSummaryForRoles(stored: StoredCard): string {
  const actions = (stored.spec.actions ?? []).filter((a) => !a.url).map((a) => `${a.id} (${a.label})`);
  const inputs = cardInputs(stored.spec).map((i) => `${i.name} (${i.kind})`);
  const done = stored.state.actions.map((a) => `${a.user_name} chose ${a.action}`);
  return [
    `[card${actions.length ? `; buttons: ${actions.join(", ")}` : ""}${inputs.length ? `; inputs: ${inputs.join(", ")}` : ""}${stored.state.closed ? "; closed" : ""}${done.length ? `; ${done.join(", ")}` : ""}]`,
  ].join("");
}

/** The values a form sent, checked against its inputs: unknown names are dropped, wrong values refused. */
export function checkValues(card: Card, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const input of cardInputs(card)) {
    let v = raw[input.name];
    if (v === "" || v === undefined || v === null || (Array.isArray(v) && !v.length)) {
      if (input.required && input.kind !== "checkbox") throw new Error(`「${input.label}」是必填项`);
      if (input.kind === "checkbox") out[input.name] = false;
      continue;
    }
    switch (input.kind) {
      case "text":
      case "textarea":
        out[input.name] = String(v).slice(0, 2000);
        break;
      case "number": {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`「${input.label}」要填数字`);
        out[input.name] = n;
        break;
      }
      case "date": {
        const s = String(v).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`「${input.label}」要填日期（YYYY-MM-DD）`);
        out[input.name] = s;
        break;
      }
      case "select": {
        const s = String(v);
        if (!input.options?.some((o) => o.value === s)) throw new Error(`「${input.label}」的选项无效`);
        out[input.name] = s;
        break;
      }
      case "multiselect": {
        const list = (Array.isArray(v) ? v : [v]).map(String);
        if (list.some((s) => !input.options?.some((o) => o.value === s)))
          throw new Error(`「${input.label}」的选项无效`);
        out[input.name] = list;
        break;
      }
      case "checkbox":
        v = v === true || v === "true" || v === "on" || v === 1;
        out[input.name] = v;
        break;
    }
  }
  return out;
}

/** How an action reads, for the role and the topic's history. */
export function actionText(card: Card, label: string, values: Record<string, unknown>): string {
  const labels = new Map(cardInputs(card).map((i) => [i.name, i] as const));
  const shown = Object.entries(values).map(([k, v]) => {
    const input = labels.get(k);
    const text = Array.isArray(v)
      ? v.map((x) => input?.options?.find((o) => o.value === x)?.label ?? x).join("、")
      : typeof v === "boolean"
        ? v
          ? "是"
          : "否"
        : (input?.options?.find((o) => o.value === v)?.label ?? String(v));
    return `${input?.label ?? k}：${text}`;
  });
  return `点击了卡片${card.title ? `「${card.title}」` : ""}的「${label}」${shown.length ? `\n${shown.join("\n")}` : ""}`;
}
