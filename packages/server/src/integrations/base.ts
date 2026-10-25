/**
 * Chat platform adapters and their declared capabilities. Capabilities are shown in the console so people
 * know what is (and is not) synchronised, instead of an integration silently pretending to be complete.
 * Adapters live on the platform side only: no computer ever holds a chat platform token.
 */
import type { Db } from "../db/client.js";
import type { Connection, ExternalConversation, Message, OutboundMessage } from "../db/schema.js";
import type { InboundMessage } from "./inbound.js";

/** The topic key of a whole channel: one topic per channel instead of per thread (InboundMessage.topicKey). */
export const CHANNEL = "__channel__";

export type InboundAction =
  | { kind: "message"; message: InboundMessage }
  | { kind: "edit"; connectionId: string; conversationId: string; ts: string; text: string }
  | { kind: "delete"; connectionId: string; conversationId: string; ts: string };

/** A connection witden keeps open to a platform (Slack Socket Mode, Feishu long connection). */
export interface SocketState {
  state: "connecting" | "connected" | "error";
  since: string;
  /** Why it is down: the platform's error code or message. */
  error?: string;
}

export interface Adapter {
  platform: string;
  test(db: Db, conn: Connection): Promise<Record<string, unknown>>;
  send(db: Db, conn: Connection, out: OutboundMessage, msg: Message): Promise<string | null>;
  parse(db: Db, conn: Connection, payload: any): Promise<InboundAction[]>;
  conversationKind?(db: Db, conn: Connection, channel: string, hint: string | null): Promise<[string, string | null]>;
  syncMembers?(db: Db, conn: Connection, conv: ExternalConversation, force?: boolean): Promise<void>;
  /** A received file: whole, or streamed as it downloads (stored without being held in memory); null: refused. */
  fetchFile?(conn: Connection, file: Record<string, any>): Promise<Buffer | AsyncIterable<Uint8Array> | null>;
  reply?(conn: Connection, channel: string, thread: string, text: string): Promise<void>;
  /** A card message changed (services/card-actions.ts): show its current form on the platform's copy. */
  updateCard?(db: Db, conn: Connection, externalId: string, msg: Message): Promise<void>;
}

export const CAPABILITIES: Record<string, Record<string, any>> = {
  slack: {
    status: "supported",
    account_types: [
      "Slack app bot user, standing for one role",
      "Socket Mode with an app-level token (no public address), or events sent to a public URL",
    ],
    conversations: ["public channel", "private channel", "direct message", "group DM"],
    threads: "a thread (root message + replies) maps to one topic",
    mentions: "@bot; the bot's role handles everything addressed to it",
    files:
      "incoming files are downloaded whatever their size (streamed to storage, files:read); roles' attachments are uploaded (files:write, otherwise links)",
    edits_deletes: "edits update the internal message; deletes remove it and derived memories",
    limits: [
      "bots only see conversations they were invited to",
      "existing private DMs between people cannot be joined",
    ],
  },
  feishu: {
    status: "experimental",
    account_types: [
      "Feishu self-built app (bot); Lark is not supported",
      "long connection with the app's ID and secret (no public address), or events sent to a public URL",
    ],
    conversations: ["group chat", "p2p chat with the bot"],
    threads: "reply threads (root_id) map to topics; p2p chats map to one topic",
    mentions: "@bot; the bot's role handles everything addressed to it",
    files:
      "images and files both ways: roles' attachments uploaded (im:resource; images in the message, up to 10 MB, files up to 30 MB, others as links), incoming ones downloaded (im:message:readonly, up to 20 MB)",
    edits_deletes: "not synchronised",
    limits: [
      "events URL: event encryption must be disabled",
      "long connection: Feishu gives each event to one connected client, so an app connected to two deployments splits its events",
    ],
  },
  github: {
    status: "supported",
    account_types: ["GitHub App (replies as <app>[bot])", "a bot account (user or machine account) with a token"],
    conversations: ["public repository", "private repository"],
    threads: "an issue or pull request maps to one topic",
    mentions: "@app-name (or @bot-login) in an issue, pull request or comment; the app's role handles it",
    files: "not synchronised (images in comments stay links)",
    edits_deletes: "comment edits update the internal message; deletes remove it and derived memories",
    limits: [
      "inline review comments on pull requests are not synchronised yet",
      "private repositories: listing collaborators needs push access, otherwise posting there counts as public",
    ],
  },
  wecom: {
    status: "planned",
    account_types: ["WeCom (企业微信) self-built app"],
    conversations: [],
    threads: "not available",
    mentions: "not available",
    files: "not available",
    edits_deletes: "not available",
    limits: ["personal WeChat is not supported: it has no official bot API"],
  },
};

const registry = new Map<string, () => Adapter>();

export function register(platform: string, factory: () => Adapter): void {
  registry.set(platform, factory);
}

export async function getAdapter(conn: Connection): Promise<Adapter> {
  // Each module registers its adapter when imported. Others are imported on their own (a Slack credential
  // check loads slack.js), so a non-empty registry does not mean this platform's adapter is in it.
  if (!registry.has(conn.platform)) {
    await import("./slack.js");
    await import("./feishu.js");
    await import("./github.js");
  }
  const factory = registry.get(conn.platform);
  if (!factory) throw new Error(`no adapter for platform ${conn.platform}`);
  return factory();
}
