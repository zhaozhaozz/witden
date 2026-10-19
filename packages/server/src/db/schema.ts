/**
 * Platform database (PostgreSQL; PGlite embeds the same engine for development and tests).
 *
 * The platform database holds identities, topics, messages, permissions, agent sessions and task state.
 * Computers never get access to it: their state lives in their own volumes, managed by the Docker Manager.
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();
const updated = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const json = <T>(name: string) => jsonb(name).$type<T>();

export type Json = Record<string, any>;
export type Mention = { type: "role" | "user"; id: string };

// --- identity ---------------------------------------------------------------------------------------

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").unique(),
  passwordHash: text("password_hash"),
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  /**
   * Set for an external member: a person from a connected Slack / Feishu workspace with no console account,
   * created when they first talk to witden. They use only the roles that connection allows, never sign in.
   */
  externalConnectionId: text("external_connection_id"),
  createdAt: created(),
  updatedAt: updated(),
});

export const apiSessions = pgTable(
  "api_sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    kind: text("kind").notNull().default("session"),
    name: text("name"),
    expiresAt: ts("expires_at"),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: created(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [index("ix_api_sessions_user").on(t.userId)],
);

/** An account on a chat platform, identified by its stable platform id (never its display name). */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: id(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    displayName: text("display_name"),
    isBot: boolean("is_bot").notNull().default(false),
    createdAt: created(),
  },
  (t) => [uniqueIndex("ux_external_identity").on(t.connectionId, t.externalUserId)],
);

// --- models & computers ---------------------------------------------------------------------------------

/** A model service: one endpoint and key, offering any number of models. */
export const modelProviders = pgTable("model_providers", {
  id: id(),
  name: text("name").notNull().unique(),
  protocol: text("protocol").notNull().default("openai"), // openai (OpenAI-compatible) | anthropic | systemone
  baseUrl: text("base_url").notNull(),
  apiKeyEncrypted: text("api_key_encrypted"),
  keyUpdatedAt: ts("key_updated_at"),
  // unchecked | ok (model list fetched) | error (listing failed: statusDetail) | revoked (key revoked)
  status: text("status").notNull().default("unchecked"),
  statusDetail: text("status_detail"),
  modelsFetchedAt: ts("models_fetched_at"),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

/** One model offered by a provider (roles, usage and topic restrictions refer to these rows). */
export const modelConfigs = pgTable(
  "model_configs",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    model: text("model").notNull(), // the id the provider knows it by
    name: text("name").notNull(), // display name; defaults to the model id
    source: text("source").notNull().default("manual"), // api (picked from the provider's list) | manual
    enabled: boolean("enabled").notNull().default(true),
    params: json<Json>("params").notNull().default({}),
    capabilities: json<Json>("capabilities").notNull().default({}),
    status: text("status").notNull().default("unchecked"), // unchecked | ok | error (capability check)
    dailyTokenLimit: integer("daily_token_limit"),
    /** Context window in tokens; null = what the provider reports or the recommendation for the model name. */
    contextWindow: integer("context_window"),
    /** A conversation is compacted when its context reaches this many tokens; null = recommended (3/4 of the window). */
    compactTokens: integer("compact_tokens"),
    createdBy: text("created_by"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ux_model_per_provider").on(t.providerId, t.model)],
);

export const computerTemplates = pgTable("computer_templates", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  version: integer("version").notNull().default(1),
  image: text("image").notNull(),
  kind: text("kind").notNull().default("shell"), // shell | desktop
  workdir: text("workdir").notNull().default("/home/witden"),
  /** The unprivileged user the runner (and therefore every AI action) runs as. Informational: set by the image. */
  user: text("user").notNull().default("witden"),
  command: json<string[] | null>("command"),
  env: json<Record<string, string>>("env").notNull().default({}),
  persistentPaths: json<string[]>("persistent_paths").notNull().default([]),
  credentialPaths: json<string[]>("credential_paths").notNull().default([]),
  /** Informational: what the image contains. Nothing is installed from this list. */
  software: json<string[]>("software").notNull().default([]),
  defaultResources: json<Json>("default_resources").notNull().default({}),
  capAdd: json<string[]>("cap_add").notNull().default([]),
  /** Containers allow privilege escalation, so the image's passwordless `sudo apt-get` works (root in the computer). */
  sudoApt: boolean("sudo_apt").notNull().default(true),
  runtime: text("runtime"),
  desktop: json<Json | null>("desktop"),
  archived: boolean("archived").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

export const computerInstances = pgTable("computer_instances", {
  id: id(),
  name: text("name").notNull().unique(),
  /** Badge colour (#rrggbb); null = derived from the id. */
  color: text("color"),
  templateId: text("template_id")
    .notNull()
    .references(() => computerTemplates.id),
  templateVersion: integer("template_version").notNull().default(1),
  /** Snapshot of the template at creation: instances never silently follow template edits. */
  spec: json<Json>("spec").notNull().default({}),
  resources: json<Json>("resources").notNull().default({}),
  // creating | running | stopped | error | deleting | deleted
  status: text("status").notNull().default("creating"),
  statusReason: text("status_reason"),
  containerId: text("container_id"),
  volumes: json<Record<string, string>>("volumes").notNull().default({}),
  pausedAi: boolean("paused_ai").notNull().default(false),
  /** sha256 of the per-computer runner secret; the secret itself only exists inside the computer. */
  runnerTokenHash: text("runner_token_hash"),
  runnerConnectedAt: ts("runner_connected_at"),
  runnerInfo: json<Json | null>("runner_info"),
  // Optional local model endpoint inside the computer, relayed through the runner (see compute/model-proxy.ts).
  modelProxyEnabled: boolean("model_proxy_enabled").notNull().default(false),
  /** Models programs in this computer may use through the proxy (model_configs ids). */
  modelProxyModelIds: json<string[]>("model_proxy_model_ids").notNull().default([]),
  /** Issued by the platform for this computer; only accepted through this computer's runner connection. */
  modelProxyKeyEncrypted: text("model_proxy_key_encrypted"),
  modelProxyKeyIssuedAt: ts("model_proxy_key_issued_at"),
  lastStartedAt: ts("last_started_at"),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

/** Exclusive control of a desktop for a continuous stretch of work (not per click). */
export const instanceLeases = pgTable(
  "instance_leases",
  {
    id: id(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => computerInstances.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("input"),
    holderType: text("holder_type").notNull(), // role | user
    holderId: text("holder_id").notNull(),
    taskId: text("task_id"),
    reason: text("reason"),
    acquiredAt: created(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [uniqueIndex("ux_lease").on(t.instanceId, t.kind)],
);

export const instanceBackups = pgTable("instance_backups", {
  id: id(),
  instanceId: text("instance_id").notNull(),
  imageRef: text("image_ref"),
  archives: json<Record<string, string>>("archives").notNull().default({}),
  includesCredentials: boolean("includes_credentials").notNull().default(true),
  status: text("status").notNull().default("running"), // running | complete | failed
  note: text("note"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdBy: text("created_by"),
  createdAt: created(),
});

/** Terminal and browser sessions living inside a computer (tracked for observability). */
export const execSessions = pgTable(
  "exec_sessions",
  {
    id: id(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => computerInstances.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // terminal | browser
    runnerSessionId: text("runner_session_id").notNull(),
    // desktop: drives what people see and can take over; background: separate session, labelled as such
    mode: text("mode").notNull().default("desktop"),
    taskId: text("task_id"),
    roleId: text("role_id"),
    title: text("title").notNull().default(""),
    status: text("status").notNull().default("open"), // open | closed
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [index("ix_exec_sessions_instance").on(t.instanceId)],
);

// --- roles & knowledge -------------------------------------------------------------------------------

export const roles = pgTable(
  "roles",
  {
    id: id(),
    name: text("name").notNull(),
    handle: text("handle").notNull().unique(),
    avatarUrl: text("avatar_url"),
    /** Badge colour (#rrggbb); null = derived from the id. */
    color: text("color"),
    description: text("description").notNull().default(""),
    systemPrompt: text("system_prompt").notNull().default(""),
    modelConfigId: text("model_config_id").references(() => modelConfigs.id),
    modelParams: json<Json>("model_params").notNull().default({}),
    /** How much the model thinks (services/effort.ts); null: the model's default. */
    reasoningEffort: text("reasoning_effort"),
    instanceId: text("instance_id").references(() => computerInstances.id),
    allowedTools: json<string[]>("allowed_tools").notNull().default([]),
    allowedContacts: json<string[]>("allowed_contacts").notNull().default([]),
    knowledgeSpaceIds: json<string[]>("knowledge_space_ids").notNull().default([]),
    approvalRequired: json<string[]>("approval_required").notNull().default([]),
    maxSteps: integer("max_steps"),
    maxTokensPerTask: integer("max_tokens_per_task"),
    dailyTokenLimit: integer("daily_token_limit"),
    /**
     * The built-in system administrator (exactly one, created by the platform, services/system-admin.ts): works
     * only in the console and may read and change witden's configuration (never its secrets).
     */
    systemAdmin: boolean("system_admin").notNull().default(false),
    status: text("status").notNull().default("active"),
    configVersion: integer("config_version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ux_single_system_admin").on(t.systemAdmin).where(sql`${t.systemAdmin}`)],
);

export const knowledgeSpaces = pgTable("knowledge_spaces", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

// --- collaboration -------------------------------------------------------------------------------------

export const topics = pgTable("topics", {
  id: id(),
  title: text("title").notNull(),
  goal: text("goal").notNull().default(""),
  kind: text("kind").notNull().default("group"), // group | dm
  status: text("status").notNull().default("active"),
  /** mention: roles answer only when @-mentioned; auto: un-mentioned messages may go to roles (see router). */
  responseMode: text("response_mode").notNull().default("mention"), // mention | auto
  maxAutoRounds: integer("max_auto_rounds"),
  allowedModelConfigIds: json<string[] | null>("allowed_model_config_ids"),
  source: text("source").notNull().default("internal"),
  createdBy: text("created_by"),
  lastMessageAt: ts("last_message_at"),
  createdAt: created(),
  updatedAt: updated(),
});

export const topicParticipants = pgTable(
  "topic_participants",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    participantType: text("participant_type").notNull(), // user | role
    participantId: text("participant_id").notNull(),
    joinedAt: created(),
    removedAt: ts("removed_at"),
    invitedBy: text("invited_by"),
  },
  (t) => [index("ix_participant_lookup").on(t.topicId, t.participantType, t.participantId)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(), // user | role | system | external
    authorId: text("author_id"),
    content: text("content").notNull().default(""),
    mentions: json<Mention[]>("mentions").notNull().default([]),
    replyToId: text("reply_to_id"),
    taskId: text("task_id"),
    approvalId: text("approval_id"),
    attachments: json<string[]>("attachments").notNull().default([]),
    source: text("source").notNull().default("web"),
    externalRef: json<Json | null>("external_ref"),
    round: integer("round").notNull().default(0),
    createdAt: created(),
    editedAt: ts("edited_at"),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("ix_messages_topic_time").on(t.topicId, t.createdAt), index("ix_messages_task").on(t.taskId)],
);

/**
 * Messages in "auto" topics waiting for the dispatcher to decide which roles (if any) take them. The worker
 * claims them like tasks, so a crash or restart never loses one.
 */
export const messageRoutes = pgTable(
  "message_routes",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    topicId: text("topic_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").notNull().default("pending"), // pending | routing | done | failed
    attempts: integer("attempts").notNull().default(0),
    claimedAt: ts("claimed_at"),
    result: json<Record<string, any> | null>("result"),
    createdAt: created(),
  },
  (t) => [index("ix_message_routes_status").on(t.status)],
);

/**
 * Agent session: one role's main conversation inside one topic (or DM). Its model context persists across
 * messages: the steps of its conversation runs (task_steps with this session_id, from session_seq
 * ``contextFrom`` on; a compaction summary starts it again). Different topics never share a session, so a role
 * working in several topics never mixes their contexts.
 */
export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: id(),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    /** Short record of earlier runs (before conversations kept their context; shown once to the first run). */
    notes: json<{ task_id: string; request: string; result: string; at: string }[]>("notes").notNull().default([]),
    runs: integer("runs").notNull().default(0),
    lastRunAt: ts("last_run_at"),
    /** What is waiting to be shown to the conversation: messages for the role, task results, follow-ups. */
    inbox: json<InboxItem[]>("inbox").notNull().default([]),
    /** Topic messages up to this time have been shown in the context. */
    cursorAt: ts("cursor_at"),
    /** Earliest follow-up the role scheduled (worker wakes the conversation then). */
    wakeAt: ts("wake_at"),
    /** People the role asked a question and whose next message here answers it, mention or not. */
    awaiting: json<{ user_ids: string[]; at: string } | null>("awaiting"),
    /** session_seq where the model context starts (0 = from the beginning). */
    contextFrom: integer("context_from").notNull().default(0),
    /** Size of the context at the last model call (prompt + answer tokens). */
    contextTokens: integer("context_tokens").notNull().default(0),
    compactions: integer("compactions").notNull().default(0),
    /** The participants line last shown to the conversation (shown again when it changes). */
    roster: text("roster"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ux_agent_session").on(t.roleId, t.topicId)],
);

/** An entry of a conversation's inbox (agent_sessions.inbox). */
export interface InboxItem {
  kind: "message" | "result" | "timer" | "instruction";
  at: string;
  /** message: the message for the role; auto = it reached the role without an @-mention (auto topics). */
  message_id?: string;
  auto?: boolean;
  /** result: a task this conversation started or delegated finished. */
  task_id?: string;
  /** timer: the role's own follow-up (shown once ``due`` has passed); instruction: a console note. */
  note?: string;
  due?: string;
  by?: string;
  /** The person this is for (who asked, or on whose behalf another role asked). */
  user_id?: string;
  /** Answers to it go where this message was asked (a follow-up promised in a Slack thread). */
  reply_to?: string;
  /** When the conversation was shown it (kept a while so a repeated delivery is recognised). */
  done?: string;
  /** timer: the automatic round it counts as (a chain of follow-ups without a person is bounded like others). */
  round?: number;
}

/**
 * Work units of the agent loop. ``kind`` "conversation": one run of a role's main conversation in a topic
 * (its context is the session's; at most one unfinished run per session, and messages arriving meanwhile are
 * fed into it). ``kind`` "task": independent work with its own context — started by a conversation
 * (start_task), delegated by another role, or from before conversations kept their context.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("task"), // conversation | task
    sessionId: text("session_id"),
    /** An independent task reports its outcome to this conversation (agent session) when it ends. */
    reportSessionId: text("report_session_id"),
    title: text("title").notNull(),
    instruction: text("instruction").notNull().default(""),
    // pending | running | waiting_human | waiting_approval | waiting_children | waiting_resource | waiting_timer
    // | paused | completed | failed | cancelled
    status: text("status").notNull().default("pending"),
    statusReason: text("status_reason"),
    requesterUserId: text("requester_user_id"),
    requesterRoleId: text("requester_role_id"),
    sourceMessageId: text("source_message_id"),
    ownerRoleId: text("owner_role_id")
      .notNull()
      .references(() => roles.id),
    collaboratorRoleIds: json<string[]>("collaborator_role_ids").notNull().default([]),
    /** Fixed at creation; a task never moves to another computer implicitly. */
    instanceId: text("instance_id"),
    parentTaskId: text("parent_task_id"),
    spawnedByTaskId: text("spawned_by_task_id"),
    depth: integer("depth").notNull().default(0),
    round: integer("round").notNull().default(0),
    envelope: json<Json>("envelope").notNull().default({}),
    roleSnapshot: json<Json>("role_snapshot").notNull().default({}),
    assignment: json<Json>("assignment").notNull().default({}),
    budget: json<Json>("budget").notNull().default({}),
    usage: json<Json>("usage").notNull().default({}),
    wait: json<Json | null>("wait"),
    progress: text("progress"),
    result: text("result"),
    error: text("error"),
    idempotencyKey: text("idempotency_key").unique(),
    /** Queue: which worker holds the task and until when (expired leases are recovered). */
    claimedBy: text("claimed_by"),
    leaseUntil: ts("lease_until"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index("ix_tasks_status").on(t.status, t.createdAt),
    index("ix_tasks_topic").on(t.topicId),
    index("ix_tasks_parent").on(t.parentTaskId),
    index("ix_tasks_spawned").on(t.spawnedByTaskId),
    // One unfinished run per conversation: later messages join it instead of starting parallel work.
    uniqueIndex("ux_tasks_open_conversation")
      .on(t.sessionId)
      .where(sql`kind = 'conversation' and status not in ('completed', 'failed', 'cancelled')`),
  ],
);

/**
 * Persistent transcript and execution log of a task. Tool calls that reach a computer are recorded as
 * "dispatched" before they are sent and "completed" afterwards, so recovery can tell an action that may
 * already have happened (uncertain) from one that never started.
 */
export const taskSteps = pgTable(
  "task_steps",
  {
    id: id(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(), // user | assistant | tool | event
    payload: json<Json>("payload").notNull().default({}),
    /** Conversation runs: the session and the step's place in its context (runs of a session never overlap). */
    sessionId: text("session_id"),
    sessionSeq: integer("session_seq"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("ux_steps_task_seq").on(t.taskId, t.seq),
    index("ix_steps_session").on(t.sessionId, t.sessionSeq),
  ],
);

/** Computer operations sent through the execution gateway (journal for recovery and audit). */
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: id(), // also the runner request id
    taskId: text("task_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    instanceId: text("instance_id").notNull(),
    op: text("op").notNull(),
    // dispatched | completed | failed | uncertain
    state: text("state").notNull().default("dispatched"),
    readOnly: boolean("read_only").notNull().default(false),
    createdAt: created(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("ix_tool_calls_task").on(t.taskId)],
);

export const approvals = pgTable("approvals", {
  id: id(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  topicId: text("topic_id").notNull(),
  roleId: text("role_id").notNull(),
  action: text("action").notNull(),
  detail: json<Json>("detail").notNull().default({}),
  status: text("status").notNull().default("pending"),
  approverUserIds: json<string[]>("approver_user_ids").notNull().default([]),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  createdAt: created(),
});

export const artifacts = pgTable(
  "artifacts",
  {
    id: id(),
    name: text("name").notNull(),
    mime: text("mime").notNull().default("application/octet-stream"),
    size: integer("size").notNull().default(0),
    sha256: text("sha256").notNull().default(""),
    storageKey: text("storage_key").notNull(),
    kind: text("kind").notNull().default("upload"), // upload | generated | screenshot | log
    topicId: text("topic_id"),
    taskId: text("task_id"),
    instanceId: text("instance_id"),
    createdByType: text("created_by_type").notNull().default("user"),
    createdById: text("created_by_id"),
    createdAt: created(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("ix_artifacts_topic").on(t.topicId)],
);

export const memories = pgTable("memories", {
  id: id(),
  scope: text("scope").notNull(), // role | team | topic (user: private notes, removed by migration 0030)
  roleId: text("role_id"),
  spaceId: text("space_id"),
  topicId: text("topic_id"),
  userId: text("user_id"),
  content: text("content").notNull(),
  sourceMessageIds: json<string[]>("source_message_ids").notNull().default([]),
  createdByType: text("created_by_type").notNull().default("user"),
  createdById: text("created_by_id"),
  createdAt: created(),
  deletedAt: ts("deleted_at"),
});

// --- integrations ----------------------------------------------------------------------------------------

/**
 * A Slack app: its own credentials (the app-level token for Socket Mode, or the signing secret for the events
 * URL; optionally the OAuth client that installs it in more workspaces). Each workspace it is installed in is a
 * connection (``connections.slack_app_id``) holding that workspace's bot token. The app outlives any of them.
 */
export const slackApps = pgTable("slack_apps", {
  id: id(),
  name: text("name").notNull().unique(),
  /** Slack's id for the app (A…), once Slack has told it. */
  appId: text("app_id"),
  credentialsEncrypted: text("credentials_encrypted"),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

export type SlackApp = typeof slackApps.$inferSelect;

export const connections = pgTable("connections", {
  id: id(),
  platform: text("platform").notNull(),
  name: text("name").notNull().unique(),
  externalWorkspaceId: text("external_workspace_id"),
  botUserId: text("bot_user_id"),
  /** Slack: the app this workspace is installed in (its token, socket and events URL are the app's). */
  slackAppId: text("slack_app_id").references(() => slackApps.id),
  credentialsEncrypted: text("credentials_encrypted"),
  settings: json<Json>("settings").notNull().default({}),
  status: text("status").notNull().default("active"),
  statusReason: text("status_reason"),
  createdBy: text("created_by"),
  createdAt: created(),
  updatedAt: updated(),
});

export const externalConversations = pgTable(
  "external_conversations",
  {
    id: id(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    kind: text("kind").notNull().default("public"), // public | private | im | mpim
    name: text("name"),
    memberIds: json<string[]>("member_ids").notNull().default([]),
    membersSyncedAt: ts("members_synced_at"),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex("ux_external_conversation").on(t.connectionId, t.externalId)],
);

export const externalThreadLinks = pgTable(
  "external_thread_links",
  {
    id: id(),
    connectionId: text("connection_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => externalConversations.id, { onDelete: "cascade" }),
    threadKey: text("thread_key").notNull(),
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    /** What the thread is on its platform: ``{kind: "issue" | "pull_request", title, url}`` for GitHub. */
    meta: json<Json>("meta").notNull().default({}),
    createdAt: created(),
  },
  (t) => [uniqueIndex("ux_thread_link").on(t.conversationId, t.threadKey), index("ix_thread_link_topic").on(t.topicId)],
);

/**
 * Durable inbound queue and dedupe record. Webhooks store the parsed event (status queued) before they
 * acknowledge; a consumer processes it afterwards and clears the payload. The unique key drops platform retries.
 */
export const processedEvents = pgTable(
  "processed_events",
  {
    id: id(),
    connectionId: text("connection_id").notNull(),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull().default("message"), // message | edit | delete
    /** The parsed action until processed; message text is not kept afterwards. */
    payload: jsonb("payload").$type<Record<string, any> | null>(),
    status: text("status").notNull().default("queued"), // queued | processing | <outcome> | failed
    attempts: integer("attempts").notNull().default(0),
    claimedAt: ts("claimed_at"),
    detail: text("detail"),
    receivedAt: created(),
  },
  (t) => [uniqueIndex("ux_processed_event").on(t.connectionId, t.eventKey)],
);

export const outboundMessages = pgTable("outbound_messages", {
  id: id(),
  connectionId: text("connection_id").notNull(),
  conversationExternalId: text("conversation_external_id").notNull(),
  threadKey: text("thread_key"),
  messageId: text("message_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  payload: json<Json>("payload").notNull().default({}),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  externalTs: text("external_ts"),
  createdAt: created(),
  updatedAt: updated(),
});

// --- governance -----------------------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    outcome: text("outcome").notNull().default("ok"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    topicId: text("topic_id"),
    taskId: text("task_id"),
    roleId: text("role_id"),
    instanceId: text("instance_id"),
    connectionId: text("connection_id"),
    detail: json<Json>("detail").notNull().default({}),
    createdAt: created(),
  },
  (t) => [
    index("ix_audit_time").on(t.createdAt),
    index("ix_audit_task").on(t.taskId),
    index("ix_audit_action").on(t.action),
  ],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    taskId: text("task_id"),
    roleId: text("role_id"),
    instanceId: text("instance_id"),
    modelConfigId: text("model_config_id"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    /** Part of the prompt the service read from its prompt cache (included in prompt_tokens). */
    cachedTokens: integer("cached_tokens").notNull().default(0),
    createdAt: created(),
  },
  (t) => [index("ix_usage_time").on(t.createdAt)],
);

export const killSwitches = pgTable("kill_switches", {
  id: id(),
  scope: text("scope").notNull(), // global | connection | role | instance | topic | task
  targetId: text("target_id"),
  reason: text("reason").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: created(),
  releasedAt: ts("released_at"),
});

export type User = typeof users.$inferSelect;
export type ModelConfig = typeof modelConfigs.$inferSelect;
export type ModelProvider = typeof modelProviders.$inferSelect;
export type ComputerTemplate = typeof computerTemplates.$inferSelect;
export type ComputerInstance = typeof computerInstances.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Topic = typeof topics.$inferSelect;
export type TopicParticipant = typeof topicParticipants.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskStep = typeof taskSteps.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type ExternalConversation = typeof externalConversations.$inferSelect;
export type KillSwitch = typeof killSwitches.$inferSelect;
export type ExecSession = typeof execSessions.$inferSelect;
export type ToolCallRecord = typeof toolCalls.$inferSelect;

export const nowSql = sql`now()`;
export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type ExternalIdentity = typeof externalIdentities.$inferSelect;
export type ApiSession = typeof apiSessions.$inferSelect;

/** Platform-wide settings edited in the console (e.g. the dispatcher model), keyed by name. */
export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: json<Record<string, any>>("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
