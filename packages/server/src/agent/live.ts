/**
 * What a role is doing right now, for people watching the topic: thinking (waiting for the model), writing
 * (the answer as the model streams it) or using a tool. Nothing here is stored — it only feeds the console's
 * live view; the finished answer still arrives as an ordinary message.
 *
 * Streamed text follows the same rule as the final answer: it is sent only when everything the task has read
 * may be shown in its topic. Otherwise watchers just see that the role is thinking or which tool it uses.
 */
import { db as getDb } from "../db/client.js";
import { publish } from "../services/events.js";

/** Batch streamed text so watchers get a few updates per second, not one per token. */
const INTERVAL_MS = 120;
/** Characters per event; keeps each NOTIFY payload far below PostgreSQL's 8000-byte limit even for CJK text. */
const CHUNK = 400;

export interface LiveTarget {
  task_id: string;
  role_id: string;
  topic_id: string;
}

export class LiveFeed {
  private pending = "";
  /** Characters of this answer already published; sent as ``offset`` so late joiners can tell they missed some. */
  private sent = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly target: LiveTarget,
    readonly showText: boolean,
  ) {}

  /** A new model call: watchers show "thinking" and drop the previous call's text. */
  thinking(): void {
    this.flush();
    this.pending = "";
    this.sent = 0;
    this.emit({ phase: "thinking" });
  }

  /** Answer text as it streams in. Ignored when the text may not be shown in the topic. */
  write(text: string): void {
    if (!this.showText || !text) return;
    this.pending += text;
    this.timer ??= setTimeout(() => this.flush(), INTERVAL_MS);
  }

  /** The conversation's context is being summarised (it got long): watchers see the role tidying up. */
  compacting(): void {
    this.flush();
    this.emit({ phase: "compacting" });
  }

  /** The role runs a tool. Only its name is shown, never the arguments. */
  async tool(name: string): Promise<void> {
    this.flush();
    this.emit({ phase: "tool", tool: name });
    await this.chain;
  }

  /** Publish whatever is buffered and wait until every event has gone out. */
  async close(): Promise<void> {
    this.flush();
    await this.chain;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending) {
      const delta = this.pending.slice(0, CHUNK);
      this.pending = this.pending.slice(CHUNK);
      this.emit({ phase: "writing", offset: this.sent, delta });
      this.sent += delta.length;
    }
  }

  /** Events go out one after another (order matters for text) and never fail the task. */
  private emit(data: Record<string, unknown>): void {
    const event = { ...this.target, ...data };
    this.chain = this.chain
      .then(() => publish(getDb(), "task.live", event, `topic:${this.target.topic_id}`))
      .catch(() => {});
  }
}
