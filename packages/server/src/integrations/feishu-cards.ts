/**
 * witden cards (services/cards.ts) as Feishu message cards (card JSON 2.0), and people's clicks on them.
 *
 * A card's blocks become card components in order: text as Markdown, fields and lists as Markdown, tables as
 * Feishu tables, charts as Feishu charts (VChart specs), progress as a bar of blocks, tabs as collapsible panels.
 * Feishu keeps a form at the card's top level and no table inside it, so all of a card's inputs and its buttons go
 * into one form at the end. A button's callback value names the witden message and the action; Feishu sends the
 * click as ``card.action.trigger`` (over the long connection or to the events URL), and the answer to it — a toast
 * and the card in its new form — is what Feishu shows (cardTrigger).
 */
import { eq } from "drizzle-orm";
import { transaction } from "../db/client.js";
import { type Connection, messages } from "../db/schema.js";
import { BadRequest, NotFound } from "../errors.js";
import { applyCardAction, refreshCardCopies, storedCard } from "../services/card-actions.js";
import { blockTitle, type CardBlock, cardInputs, type StoredCard } from "../services/cards.js";
import { consoleBase } from "../services/public-url.js";
import { addParticipant, getTopic, participant } from "../services/topics.js";
import { toFeishu } from "./feishu-format.js";

const COLORS: Record<string, string> = {
  default: "default",
  blue: "blue",
  green: "green",
  orange: "orange",
  red: "red",
  purple: "purple",
  grey: "grey",
};

const plain = (content: string) => ({ tag: "plain_text", content });
const md = (content: string) => ({ tag: "markdown", content: toFeishu(content, { baseUrl: consoleBase() }) });
const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function chart(b: Extract<CardBlock, { type: "chart" }>) {
  const unit = b.unit ? `（${b.unit}）` : "";
  if (b.kind === "pie") {
    const values = b.labels.map((label, i) => ({ label, value: b.series[0]?.values[i] ?? 0 }));
    return {
      tag: "chart",
      aspect_ratio: "4:3",
      chart_spec: {
        type: "pie",
        title: b.title ? { text: b.title + unit } : undefined,
        data: { values },
        valueField: "value",
        categoryField: "label",
        legends: { visible: true, orient: "bottom" },
        label: { visible: true },
      },
    };
  }
  const values = b.series.flatMap((s) =>
    b.labels.map((label, i) => ({ label, series: s.name, value: s.values[i] ?? 0 })),
  );
  return {
    tag: "chart",
    aspect_ratio: "16:9",
    chart_spec: {
      type: b.kind,
      title: b.title ? { text: b.title + unit } : undefined,
      data: { values },
      xField: b.kind === "bar" && b.series.length > 1 ? ["label", "series"] : "label",
      yField: "value",
      seriesField: "series",
      legends: { visible: b.series.length > 1, orient: "bottom" },
    },
  };
}

/** One content block, under its title if it has one (inputs go to the form, so not here). */
function element(b: CardBlock): object[] {
  const t = blockTitle(b);
  const body = content(b);
  return t && body.length ? [md(`**${t}**`), ...body] : body;
}

function content(b: CardBlock): object[] {
  switch (b.type) {
    case "text":
      return b.text.trim() ? [md(b.text)] : [];
    case "fields":
      return [md(b.items.map((f) => `**${f.label}**　${f.value}`).join("\n"))];
    case "table":
      return [
        {
          tag: "table",
          page_size: Math.min(Math.max(b.rows.length, 1), 10),
          columns: b.columns.map((c, i) => ({
            name: `c${i}`,
            display_name: c.label,
            data_type: "text",
            horizontal_align: c.align ?? "left",
          })),
          rows: b.rows.map((r) => Object.fromEntries(b.columns.map((c, i) => [`c${i}`, cell(r[c.key])]))),
        },
      ];
    case "chart":
      return [chart(b)];
    case "list":
      return [
        md(
          b.items
            .map((i) => `- **${i.title}**${i.badge ? ` \`${i.badge}\`` : ""}${i.subtitle ? `\n  ${i.subtitle}` : ""}`)
            .join("\n"),
        ),
      ];
    case "progress": {
      const max = b.max ?? 100;
      const pct = Math.round((Math.min(b.value, max) / max) * 100);
      const bar = "▓".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
      return [md(`${b.label ? `**${b.label}**　` : ""}${bar} ${pct}%`)];
    }
    case "divider":
      return [{ tag: "hr" }];
    case "tabs":
      return b.tabs.map((t, i) => ({
        tag: "collapsible_panel",
        expanded: i === 0,
        header: { title: { tag: "markdown", content: `**${t.label}**` } },
        elements: (t.blocks as CardBlock[]).flatMap(element),
      }));
    case "input":
      return [];
    case "app":
      // Feishu runs no code: what the app is for, and where it runs
      return [md(`${b.fallback}\n\n*（交互小应用：在 witden 控制台中打开这张卡片使用）*`)];
  }
}

/** A form field: its label (Markdown), then the component Feishu submits under its name. */
function field(input: ReturnType<typeof cardInputs>[number], disabled: boolean): object[] {
  const label = md(`**${input.label}**${input.required ? " *" : ""}`);
  const common = { name: input.name, required: !!input.required, disabled };
  const options = (input.options ?? []).map((o) => ({ text: plain(o.label), value: o.value }));
  const placeholder = plain(input.placeholder ?? "");
  switch (input.kind) {
    case "select":
      return [
        label,
        {
          tag: "select_static",
          ...common,
          placeholder,
          options,
          ...(input.default ? { initial_option: String(input.default) } : {}),
        },
      ];
    case "multiselect":
      return [label, { tag: "multi_select_static", ...common, placeholder, options }];
    case "checkbox":
      // a yes / no choice: Feishu's checker is not a form field everywhere
      return [
        label,
        {
          tag: "select_static",
          ...common,
          placeholder,
          options: [
            { text: plain("是"), value: "true" },
            { text: plain("否"), value: "false" },
          ],
          ...(input.default !== undefined ? { initial_option: input.default ? "true" : "false" } : {}),
        },
      ];
    case "date":
      return [
        label,
        {
          tag: "date_picker",
          ...common,
          placeholder,
          ...(input.default ? { initial_date: String(input.default) } : {}),
        },
      ];
    default:
      return [
        label,
        {
          tag: "input",
          ...common,
          placeholder,
          ...(input.kind === "textarea" ? { input_type: "multiline_text", rows: 3 } : {}),
          ...(input.default !== undefined ? { default_value: String(input.default) } : {}),
        },
      ];
  }
}

/** A witden card as a Feishu card (JSON 2.0); ``messageId`` is the witden message its buttons point at. */
export function toFeishuCard(card: StoredCard, messageId: string): object {
  const { spec, state } = card;
  const elements: object[] = spec.blocks.flatMap(element);
  const buttons = (spec.actions ?? []).map((a) => ({
    tag: "column",
    width: "auto",
    elements: [
      {
        tag: "button",
        name: `a_${a.id}`,
        text: plain(a.label),
        type: a.style === "primary" ? "primary" : a.style === "danger" ? "danger" : "default",
        ...(a.url
          ? { behaviors: [{ type: "open_url", default_url: a.url }] }
          : {
              disabled: state.closed,
              behaviors: [{ type: "callback", value: { witden: "card", m: messageId, a: a.id } }],
            }),
      },
    ],
  }));
  const inputs = cardInputs(spec);
  const row = { tag: "column_set", horizontal_spacing: "8px", columns: buttons };
  if (inputs.length) {
    // the inputs and buttons as one form; a button submits it
    const formButtons = {
      ...row,
      columns: buttons.map((c) => ({
        ...c,
        elements: c.elements.map((b: any) =>
          b.behaviors[0].type === "callback" ? { ...b, form_action_type: "submit" } : b,
        ),
      })),
    };
    elements.push({
      tag: "form",
      name: "witden_form",
      elements: [...inputs.flatMap((i) => field(i, state.closed)), formButtons],
    });
  } else if (buttons.length) elements.push(row);
  if (state.actions.length)
    elements.push(md(state.actions.map((a) => `*${a.user_name} 选择了「${a.label}」*`).join("\n")));
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    ...(spec.title
      ? {
          header: {
            title: plain(spec.title),
            ...(spec.subtitle ? { subtitle: plain(spec.subtitle) } : {}),
            template: COLORS[spec.color ?? "default"] ?? "default",
          },
        }
      : {}),
    body: { elements: elements.length ? elements : [md(" ")] },
  };
}

const toast = (type: "success" | "error" | "info", content: string) => ({ toast: { type, content } });

/**
 * A click on a witden card in Feishu (card.action.trigger): the same action as in the console, by the person whose
 * Feishu account it is. Feishu shows the answer: a toast, and the card in its new form.
 */
export async function cardTrigger(conn: Connection, payload: any): Promise<object> {
  const ev = payload?.event ?? {};
  const value = ev.action?.value ?? {};
  if (value.witden !== "card" || !value.m) return {};
  const openId: string = ev.operator?.open_id ?? "";
  const feishuMessage: string | undefined = ev.context?.open_message_id;
  const { resolveIdentity } = await import("./inbound.js");
  const { FeishuAdapter } = await import("./feishu.js");
  // the name as for a message, looked up before the transaction (it may ask Feishu)
  const name = openId
    ? await new FeishuAdapter().userName(conn, openId, ev.context?.open_chat_id ?? null).catch(() => null)
    : null;
  let messageId = "";
  const answer = await transaction(async (db) => {
    const [msg] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, String(value.m)))
      .limit(1);
    const card = msg && storedCard(msg);
    if (!msg || !card) return toast("error", "这张卡片已不存在");
    messageId = msg.id;
    const user = openId ? await resolveIdentity(db, conn, openId, name) : null;
    if (!user) return toast("error", "你的飞书账号还没有关联到 witden，不能操作这张卡片。请联系管理员关联。");
    const topic = await getTopic(db, msg.topicId);
    // Whoever can see the conversation takes part in it, as when they send a message.
    if (!(await participant(db, topic.id, "user", user.id))) await addParticipant(db, topic, "user", user.id);
    try {
      const values = ev.action?.form_value && typeof ev.action.form_value === "object" ? ev.action.form_value : {};
      const done = await applyCardAction(db, topic, msg, user, String(value.a), values, "feishu");
      return {
        ...toast("success", "已提交"),
        card: { type: "raw", data: toFeishuCard(done.card, msg.id) },
      };
    } catch (err) {
      if (err instanceof BadRequest || err instanceof NotFound) return toast("error", (err as Error).message);
      throw err;
    }
  });
  // Other copies of the card (in other chats) follow; this one takes the card in the answer.
  if (messageId) void refreshCardCopies(messageId, feishuMessage);
  return answer;
}
