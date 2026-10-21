import type { EffortChoices } from "../lib/effort";
// Response shapes of the witden API (see packages/server/src/api/*.ts and db/schema.ts).
// Top-level keys are snake_case; nested JSON columns are returned exactly as stored.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Dict = Record<string, unknown>;

export interface User {
  id: string;
  name: string;
  email?: string | null;
  avatar_url?: string | null;
  is_admin?: boolean;
  is_active: boolean;
  /** An external member: a person from this Slack / Feishu connection, with no console sign-in. */
  external_connection_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Me extends User {
  /** What this account may do (a console account: everything). */
  permissions: string[];
}

export interface Participant {
  type: "user" | "role";
  id: string;
  name: string;
  joined_at: string;
  handle?: string | null;
  avatar_url?: string | null;
  /** Roles: badge colour and the computer the role works on. */
  color?: string | null;
  instance?: { id: string; name: string; color: string | null } | null;
  status?: string | null;
}

export interface Topic {
  id: string;
  title: string;
  goal: string;
  work_instructions: string;
  kind: "group" | "dm";
  status: "active" | "archived";
  /** How roles respond: only when @-mentioned, or automatically (one role decides, several: the dispatcher). */
  response_mode: "mention" | "auto";
  max_auto_rounds: number | null;
  allowed_model_config_ids: string[] | null;
  source: string;
  created_by: string | null;
  last_message_at: string | null;
  /** DMs: the role on the other side. */
  dm_role_id?: string | null;
  created_at: string;
  updated_at: string;
  /** You take part (a DM: only its own person; a DM with a disabled role: nobody). */
  can_post: boolean;
  participants?: Participant[];
  /** In lists: the roles taking part. */
  role_ids?: string[];
  /** Where it lives outside the console (a Slack thread or DM, a GitHub issue or PR), or null. */
  channel?: ChannelInfo | null;
}

export interface ChannelInfo {
  connection_id: string;
  connection_name: string;
  platform: string;
  conversation_id: string;
  /** public | private | im | mpim */
  conversation_kind: string;
  /** Slack channel name, GitHub "owner/repo". */
  conversation_name: string | null;
  thread_key: string;
  /** GitHub: issue | pull_request. */
  thread_kind: string | null;
  /** The role the connection's bot stands for, if chosen. */
  role_id?: string | null;
  url: string | null;
}

export interface ExternalContext {
  connection_id?: string;
  conversation_id?: string;
  conversation_kind?: string;
  thread_key?: string;
}

export interface Mention {
  type: "role" | "user";
  id: string;
}

export interface Message {
  id: string;
  topic_id: string;
  author_type: "user" | "role" | "system" | "external";
  author_id: string | null;
  content: string;
  mentions: Mention[];
  reply_to_id: string | null;
  task_id: string | null;
  approval_id?: string | null;
  /** The affected role at the time it joined or left, independent of current topic membership. */
  participant_change?: {
    action: "added" | "removed";
    actor_name: string;
    role: { id: string; name: string; handle: string | null; color: string | null; avatar_url: string | null };
  } | null;
  attachments: string[];
  /** Sent from a linked topic: the topic it came from. */
  topic_delivery?: { source_topic_id: string } | null;
  source: string;
  round: number;
  created_at: string;
  edited_at: string | null;
  deleted: boolean;
}

export interface PostMessageResult extends Message {
  /**
   * The roles' conversations the message went to. joined: the role was already working there and reads it
   * at its next step.
   */
  tasks: { id: string; owner_role_id: string; status: string; kind?: "conversation" | "task"; joined?: boolean }[];
}

export interface Artifact {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  kind: string;
  topic_id: string | null;
  task_id: string | null;
  instance_id: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_human"
  | "waiting_approval"
  | "waiting_children"
  | "waiting_resource"
  | "waiting_timer"
  | "waiting_role"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface Ref {
  id: string;
  name?: string;
  title?: string;
  handle?: string;
  status?: string;
  kind?: string;
}

/**
 * Why a task is not running (`task.wait`), as written by the server. Fields depend on `type`; a paused task
 * keeps the wait it had plus `resume_to` / `paused_by`. Viewers without access to the task's material only
 * get `{type}`.
 */
export interface TaskWait {
  type?: "instance" | "approval" | "children" | "human" | "timer" | string;
  /** instance: the computer the task is pinned to and since when it waits. */
  instance_id?: string | null;
  since?: string;
  /** instance: the computer operation that will be retried when the computer is back. */
  retry_call?: { id: string; name: string; arguments?: unknown };
  approval_id?: string;
  child_ids?: string[];
  user_ids?: string[];
  /** timer */
  until?: string;
  note?: string;
  tool_call_id?: string;
  /** paused: the state to return to, and who paused it (user | kill:<id> | takeover:<instance id>). */
  resume_to?: string;
  paused_by?: string;
  [key: string]: unknown;
}

export interface Task {
  id: string;
  revision?: number;
  iterations?: {
    id: string;
    revision: number;
    status: string;
    result: string | null;
    error: string | null;
    finished_at: string | null;
  }[];
  topic_id: string;
  /**
   * conversation: one run of a role's conversation in the topic (its context is the session's);
   * task: independent work with its own context.
   */
  kind: "conversation" | "task";
  /** Agent session (role × topic) of a conversation run. */
  session_id: string | null;
  /** The conversation an independent task reports its result to. */
  report_session_id: string | null;
  title: string;
  instruction: string;
  status: TaskStatus;
  status_reason: string | null;
  requester_user_id: string | null;
  requester_role_id: string | null;
  source_message_id: string | null;
  owner_role_id: string;
  collaborator_role_ids: string[];
  instance_id: string | null;
  /** Parent that waits for this task's result (delegation). */
  parent_task_id: string | null;
  /** Task that started this one, whether or not it waits for it. */
  spawned_by_task_id: string | null;
  depth: number;
  round: number;
  envelope: Dict;
  assignment: Dict;
  budget: Dict;
  usage: Dict;
  wait: TaskWait | null;
  progress: string | null;
  result: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  owner: { id: string; handle: string; name: string; color?: string | null; avatar_url?: string | null } | null;
  instance: { id: string; name: string; status: string; color?: string | null } | null;
  topic: { id: string; title: string; kind: string } | null;
  requester: { id: string; name: string } | null;
  children?: { id: string; title: string; status: TaskStatus; owner_role_id: string }[];
  approvals?: Approval[];
  role_snapshot?: Dict;
  /** The viewer may not see the task's topic: text fields are "[restricted]", the log is hidden. */
  content_restricted?: boolean;
}

export interface TaskStep {
  seq: number;
  kind: "system" | "user" | "assistant" | "tool" | "event";
  payload: Dict;
  created_at?: string;
}

export interface AuditEntry {
  id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  outcome: string;
  resource_type: string | null;
  resource_id: string | null;
  topic_id: string | null;
  task_id: string | null;
  role_id: string | null;
  instance_id: string | null;
  connection_id: string | null;
  detail: Dict | string;
  created_at: string;
}

export interface TaskTrace {
  task: Task;
  source: ExternalContext & Dict;
  assignment: Dict;
  envelope: Dict;
  session_id: string | null;
  audit: AuditEntry[];
}

/** One role's context inside one topic; different topics never share a session. */
export interface AgentSession {
  id: string;
  role_id: string;
  topic_id: string;
  status: string;
  /** Short record of earlier runs, from before conversations kept their context (stored with camelCase keys). */
  notes: { taskId?: string; task_id?: string; request: string; result: string; at: string }[];
  runs: number;
  last_run_at: string | null;
  /** Size of the conversation's context at its last model call, in tokens. */
  context_tokens: number;
  compactions: number;
  /** Items (messages, results, due follow-ups) waiting to be shown to the conversation. */
  waiting: number;
  next_follow_up_at: string | null;
  open_run: { id: string; status: TaskStatus } | null;
  /** The role's model: its context window and when the conversation is compacted (null: no chat model). */
  context_window: number | null;
  compact_at: number | null;
  created_at: string;
  updated_at: string;
  /** Present on GET /api/roles/:id/sessions. */
  topic?: { id: string; title: string; kind: string };
  /** Present on GET /api/topics/:id/sessions. */
  role?: { id: string; handle: string; name: string } | null;
}

export interface Approval {
  id: string;
  task_id: string;
  topic_id: string;
  role_id: string;
  action: string;
  detail: Dict;
  status: "pending" | "approved" | "rejected";
  approver_user_ids: string[];
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  can_decide?: boolean;
  can_allow_for_task_run?: boolean;
  decision_scope?: "once" | "task_run" | null;
  role?: { id: string; handle: string; name?: string; color?: string | null; avatar_url?: string | null } | null;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  version: number;
  image: string;
  kind: "shell" | "desktop";
  workdir: string;
  /** Unprivileged user the runner and every AI action run as (never root). */
  user: string;
  command: string[] | null;
  env: Record<string, string>;
  persistent_paths: string[];
  credential_paths: string[];
  /** Debian packages a new computer's software list starts with (installed whenever it starts). */
  software: string[];
  default_resources: Resources;
  cap_add: string[];
  runtime: string | null;
  desktop: Dict | null;
  archived: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  instance_count: number;
}

/** The latest automatic install of a computer's software list. */
export interface SoftwareStatus {
  state: "installing" | "ok" | "failed";
  packages: string[];
  missing?: string[];
  error?: string;
  at: string;
}

export interface Resources {
  cpus?: number;
  memory_mb?: number;
  pids_limit?: number;
  disk_gb?: number;
  network?: string;
}

export interface InstanceOperator {
  holder_type: "role" | "user";
  holder_id: string;
  task_id: string | null;
  reason: string | null;
  expires_at: string;
}

/** What the runner reported when it connected (nested JSON, camelCase as sent by the runner). */
export interface RunnerInfo {
  hostname?: string;
  user?: string;
  uid?: number;
  workdir?: string;
  desktop?: { display?: string; width?: number; height?: number; vncPort?: number; vncViewPort?: number } | null;
  browser?: boolean;
  tools?: string[];
  /** Other processes in the computer could read the runner token (absent: a runner too old to check). */
  tokenExposed?: boolean;
}

/** Live connection of the computer's runner to the hub of the API process answering the request. */
export interface RunnerStatus {
  connected: boolean;
  via?: "websocket" | "stdio" | "memory" | string;
  /** When the current connection was established. */
  since?: string;
  info?: RunnerInfo;
}

export interface Instance {
  id: string;
  name: string;
  /** Badge colour (#rrggbb); null = derived from the id. */
  color: string | null;
  template_id: string;
  template_version: number;
  spec: Dict & { kind?: string; image?: string; user?: string; workdir?: string; desktop?: Dict | null };
  resources: Resources;
  status: "creating" | "running" | "stopped" | "error" | "deleting" | "deleted";
  status_reason: string | null;
  container_id: string | null;
  volumes: Record<string, string>;
  /** A person has taken over: AI work on this computer waits. */
  paused_ai: boolean;
  /** Last time a runner authenticated, and what it reported then (kept after it disconnects). */
  runner_connected_at: string | null;
  runner_info: RunnerInfo | null;
  runner: RunnerStatus;
  last_started_at: string | null;
  /** This computer's software list: Debian packages installed (when missing) whenever it starts. */
  software: string[];
  software_status: SoftwareStatus | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  roles: {
    id: string;
    name: string;
    handle: string;
    status: string;
    color?: string | null;
    avatar_url?: string | null;
  }[];
  operator: InstanceOperator | null;
  active_tasks?: { id: string; title: string; status: TaskStatus; owner_role_id: string }[];
  waiting_tasks?: string[];
  shared_scope?: {
    note: string;
    shared_by_roles: string[];
    persistent_paths: string[];
    credential_paths: string[];
    home: string;
  };
  applies_after?: string;
}

export interface InstanceStats {
  limits: Resources;
  usage?: {
    cpu_percent?: number;
    memory_bytes?: number;
    memory_limit_bytes?: number | null;
    net_rx_bytes?: number;
    net_tx_bytes?: number;
    block_read_bytes?: number;
    block_write_bytes?: number;
    pids?: number | null;
  };
  volumes?: Record<string, number>;
}

export interface ActionPreview {
  will_clear: string[];
  will_keep?: string[];
  roles_detached?: string[];
  note?: string;
  active_tasks: string[];
}

/** Terminal, browser and external-agent sessions living inside a computer. */
export interface ExecSession {
  id: string;
  instance_id: string;
  kind: "terminal" | "browser" | string;
  runner_session_id: string;
  /** desktop: the visible desktop people can watch and take over; background: a separate, unseen session. */
  mode: "desktop" | "background" | string;
  task_id: string | null;
  role_id: string | null;
  title: string;
  status: "open" | "closed" | string;
  created_at: string;
  updated_at: string;
}

export interface Backup {
  id: string;
  instance_id: string;
  image_ref: string | null;
  archives: Record<string, string>;
  includes_credentials: boolean;
  status: "running" | "complete" | "failed" | string;
  note: string | null;
  size_bytes: number;
  created_by: string | null;
  created_at: string;
}

export interface ExecResult {
  exit_code: number;
  output: string;
  timed_out: boolean;
  truncated: boolean;
}

export interface RoleImpact {
  active_tasks: { id: string; title: string; status: TaskStatus }[];
  topics: number;
  memories: number;
  notes: string[];
}

export interface Role {
  id: string;
  name: string;
  handle: string;
  avatar_url: string | null;
  /** Badge colour (#rrggbb); null = derived from the id. */
  color: string | null;
  description: string;
  system_prompt?: string;
  model_config_id: string | null;
  model_params?: Dict;
  instance_id: string | null;
  allowed_tools: string[];
  allowed_contacts?: string[];
  knowledge_space_ids?: string[];
  approval_required?: string[];
  max_steps: number | null;
  max_tokens_per_task: number | null;
  daily_token_limit: number | null;
  /** How much the model thinks (null: the model's default). */
  reasoning_effort: string | null;
  /** Works only in the console and may read and change witden's configuration (never its secrets). */
  system_admin: boolean;
  status: "active" | "disabled";
  config_version: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  instance: { id: string; name: string; status: string; kind?: string; color?: string | null } | null;
  model: {
    id: string;
    name: string;
    /** "provider / model" */
    label?: string;
    provider?: { id: string; name: string };
    capabilities: Capabilities;
    status: string;
    effort?: EffortChoices | null;
  } | null;
  tokens_today?: number;
  /** Configuration problems that will make work fail (no model, computer stopped, ...). */
  warnings?: string[];
  impact?: RoleImpact;
  /** PATCH response: changed fields (server-side camelCase names) and the impact report. */
  result?: { changes?: string[]; impact?: RoleImpact } & Dict;
}

export interface ToolGroup {
  group: string | null;
  description: string;
  tools: string[];
  /** What a new role gets: the group's level, and single tools that ask while the group is allowed. */
  default_level?: "allow" | "ask" | "off";
  default_ask?: string[];
}

/** The Feishu tools roles may be given, and the Feishu apps (companies) they can be given for. */
/** The tools roles may be given per connection of a platform (/api/roles/feishu-tools, /api/roles/github-tools). */
export interface PlatformTools {
  products: { key: string; label: string; description: string; read: string[]; write: string[] }[];
  apps: {
    id: string;
    name: string;
    status: string;
    /** GitHub: the account or App the tools act as. */
    acts_as?: string | null;
    /** GitHub: the connection only authenticates the tools (takes no messages). */
    auth_only?: boolean;
  }[];
}

export interface Capabilities {
  chat?: boolean | null;
  tools?: boolean | null;
  vision?: boolean | null;
  checked_at?: string;
  errors?: Record<string, string>;
  error?: string | null;
  /** Response time of the first check request. */
  latency_ms?: number;
  /** System One models: answered the check question correctly. */
  decide?: boolean | null;
  /** Reasoning effort levels the model's service reported at the last check (null: none reported). */
  effort?: { levels: string[]; default: string | null; param: string } | null;
}

/** One model offered by a provider (roles, grants and usage refer to these). */
export interface ModelConfig {
  id: string;
  provider_id: string;
  /** The id the provider knows it by. */
  model: string;
  /** Display name; defaults to the model id. */
  name: string;
  /** "provider / name" */
  label: string;
  source: "api" | "manual";
  enabled: boolean;
  /** False when the model is disabled or its provider's key was revoked. */
  usable: boolean;
  params: Dict;
  capabilities: Capabilities;
  status: "unchecked" | "ok" | "error";
  daily_token_limit: number | null;
  /** Set by an administrator (null: the provider's report or the model catalog). */
  context_window: number | null;
  compact_tokens: number | null;
  /** This model's entry in the model catalog (models.dev); null when it lists none. */
  catalog: CatalogMatch | null;
  /** In effect: the window, the compaction threshold and where the window came from (null for decision models). */
  context?: { window: number; compact_at: number; source: "model" | "provider" | "catalog" | "default" } | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  used_by_roles?: string[];
  tokens_today?: number;
  /** Present in the flat /api/models list. */
  provider?: { id: string; name: string; protocol: ModelProtocol; status: ModelProvider["status"] };
  /** The reasoning effort levels a role may pick (null for decision models). */
  effort?: EffortChoices | null;
}

/** A model's entry in the model catalog (server: services/model-catalog.ts). */
export interface CatalogMatch {
  /** The catalog's provider, e.g. "deepseek" / "DeepSeek". */
  provider: string;
  provider_name: string;
  model: string;
  name: string;
  /** official: the maker's data; third_party: the data of the third party this provider is; common: no maker lists it. */
  basis: "official" | "third_party" | "common";
  context: number;
  input: number | null;
  output: number | null;
  efforts: string[] | null;
  fetched_at: string;
}

/** Where the model catalog comes from and when it was fetched. */
export interface CatalogStatus {
  /** Where refreshing fetches from; null when it is turned off. */
  url: string | null;
  source_url: string | null;
  fetched_at: string | null;
  providers: number;
  models: number;
}

/** openai / anthropic: chat models; systemone: decision models (TypeSafe Jev, Laya). */
export type ModelProtocol = "openai" | "anthropic" | "systemone";

/** A model service: one endpoint, protocol and key, offering any number of models. */
export interface ModelProvider {
  id: string;
  name: string;
  protocol: ModelProtocol;
  /** unchecked | ok (model list fetched) | error (listing failed) | revoked (key revoked) */
  status: "unchecked" | "ok" | "error" | "revoked";
  models: ModelConfig[];
  // the fields below are only returned to people who manage model services
  base_url?: string;
  status_detail?: string | null;
  models_fetched_at?: string | null;
  key_updated_at?: string | null;
  has_api_key?: boolean;
  created_at?: string;
}

/** A computer's model access: a local endpoint inside it, relayed and checked by the platform. */
export interface ModelProxyInfo {
  enabled: boolean;
  model_ids: string[];
  models: { id: string; alias: string; label: string; protocol: ModelProtocol; usable: boolean }[];
  /** Whether a key was issued. The key itself is never shown: the runner writes it into the computer. */
  has_key: boolean;
  key_issued_at: string | null;
  endpoints: { openai: string; anthropic: string; systemone: string };
  env_file: string;
  runner_connected: boolean;
}

/** A model listed by the provider's own API. */
export interface RemoteModel {
  id: string;
  name: string | null;
  added: boolean;
  /** The context window the service reports, if it does. */
  context_window: number | null;
}

export interface TraceStep {
  step: string;
  detail: unknown;
}

export interface RoleDecision {
  role_id: string;
  allowed: boolean;
  instance_id: string | null;
  reasons: string[];
}

export interface ExternalIdentity {
  id: string;
  connection_id: string;
  external_user_id: string;
  user_id: string | null;
  display_name: string | null;
  is_bot: boolean;
  created_at: string;
}

export interface UsageRow {
  key: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  calls: number;
}

export interface KillSwitch {
  id: string;
  scope: "global" | "connection" | "role" | "instance" | "topic" | "task";
  target_id: string | null;
  reason: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  released_at: string | null;
  tasks_paused?: unknown;
}

export interface KnowledgeSpace {
  id: string;
  name: string;
  description: string;
  created_by: string | null;
  created_at: string;
}

export interface Memory {
  id: string;
  scope: "role" | "team" | "topic";
  role_id: string | null;
  space_id: string | null;
  topic_id: string | null;
  user_id: string | null;
  title: string;
  keywords: string[];
  content: string;
  source_message_ids: string[];
  created_by_type: string;
  created_by_id: string | null;
  created_at: string;
  updated_at: string | null;
}

/** A Slack app: shared by the workspaces it is installed in, each of which is a connection. */
export interface SlackApp {
  id: string;
  name: string;
  /** Slack's id for the app (A…), once known. */
  app_id: string | null;
  slack_mode: "socket" | "http";
  socket: Connection["socket"];
  events_url: string;
  webhook: Connection["webhook"];
  /** Its app-level token or signing secret is saved. */
  has_credentials: boolean;
  /** Its OAuth client is saved, so it can be installed in more workspaces. */
  slack_oauth: boolean;
  workspaces: { id: string; name: string; team_id: string | null; status: string }[];
  created_at?: string;
  updated_at?: string;
}

export interface Connection {
  id: string;
  platform: "slack" | "feishu" | string;
  name: string;
  status: "active" | "paused" | "error" | string;
  status_reason: string | null;
  settings: {
    /** The role the connection's bot stands for; external members may use only it. */
    role_id?: string | null;
    auto_provision_users?: boolean;
    /** Feishu: how events arrive (absent: the events URL, as before there was a choice). */
    feishu_mode?: "socket" | "http";
    /** Feishu: other bots @-mentioning the bot go to its role. */
    bot_requests?: boolean;
    /** GitHub: no messages; the account only authenticates the GitHub tools roles are given. */
    auth_only?: boolean;
    [key: string]: unknown;
  };
  has_credentials: boolean;
  /** GitHub: acting as a GitHub App or as a bot account. */
  github_auth?: "app" | "token";
  external_workspace_id: string | null;
  /** Slack: events over a socket witden keeps open (Socket Mode), or sent to the events URL. */
  slack_mode?: "socket" | "http";
  /** Feishu: events over the long connection witden keeps open, or sent to the events URL. */
  feishu_mode?: "socket" | "http";
  /** Feishu: requests from other bots in a row taken before waiting for a person (with bot_requests). */
  bot_request_limit?: number;
  /**
   * Slack Socket Mode or the Feishu long connection: the state of the server's connection (a Slack workspace
   * shows its app's).
   */
  socket?: { state: "connecting" | "connected" | "error"; since: string; error?: string } | null;
  /** Slack: the app this workspace is installed in (its token, socket and events URL are the app's). */
  slack_app?: { id: string; name: string } | null;
  /** How the platform's calls to the events URL went lately (kept in the server's memory). */
  webhook?: {
    verified_at?: string;
    received_at?: string;
    rejected_at?: string;
    rejected_reason?: string;
  } | null;
  bot_user_id: string | null;
  capabilities?: unknown;
  events_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ExternalConversation {
  id: string;
  connection_id: string;
  external_id: string;
  kind: "public" | "private" | "im" | "mpim" | string;
  name: string | null;
  member_ids?: string[];
  members_synced_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface OutboundMessage {
  id: string;
  connection_id: string;
  conversation_external_id: string;
  thread_key: string | null;
  message_id: string | null;
  payload: Dict;
  status: "pending" | "sent" | "failed" | "blocked" | string;
  attempts: number;
  last_error: string | null;
  external_ts: string | null;
  created_at: string;
  updated_at: string;
}
