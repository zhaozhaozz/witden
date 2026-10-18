/** Data migrations, run against the previous schema with existing rows. */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const DIR = path.resolve(import.meta.dirname, "../drizzle");

async function apply(db: PGlite, tag: string) {
  const sql = fs.readFileSync(path.join(DIR, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.exec(statement);
  }
}

describe("0002_model_providers", () => {
  it("turns each model configuration into a provider with one model, keeping every reference", async () => {
    const db = new PGlite();
    await apply(db, "0000_init");
    await apply(db, "0001_inbound_queue");
    await db.exec(`
      insert into model_configs (id, name, provider, base_url, model, api_key_encrypted, params, status, daily_token_limit)
        values ('mdl_aaaa', 'prod gpt', 'openai', 'https://api.example/v1', 'gpt-x', 'v1.iv.tag.data', '{"temperature":0.2}', 'ok', 5000),
               ('mdl_bbbb', 'old claude', 'anthropic', 'https://api.anthropic.example', 'claude-x', null, '{}', 'revoked', null);
      insert into roles (id, name, handle, model_config_id) values ('role_1', 'Dev', 'dev', 'mdl_aaaa');
      insert into grants (id, subject_type, subject_id, permission, resource_type, resource_id)
        values ('grt_1', 'user', 'u1', 'model.use', 'model', 'mdl_aaaa');
      insert into usage_records (id, model_config_id, prompt_tokens, completion_tokens) values ('use_1', 'mdl_aaaa', 10, 5);
    `);
    await apply(db, "0002_model_providers");

    const providers = (await db.query("select * from model_providers order by name")).rows as any[];
    expect(providers.map((p) => [p.id, p.name, p.protocol, p.base_url, p.api_key_encrypted, p.status])).toEqual([
      ["prv_bbbb", "old claude", "anthropic", "https://api.anthropic.example", null, "revoked"],
      ["prv_aaaa", "prod gpt", "openai", "https://api.example/v1", "v1.iv.tag.data", "unchecked"],
    ]);
    const models = (await db.query("select * from model_configs order by id")).rows as any[];
    expect(models.map((m) => [m.id, m.provider_id, m.model, m.name, m.status, m.daily_token_limit])).toEqual([
      ["mdl_aaaa", "prv_aaaa", "gpt-x", "prod gpt", "ok", 5000],
      ["mdl_bbbb", "prv_bbbb", "claude-x", "old claude", "unchecked", null],
    ]);
    expect(models[0].params).toEqual({ temperature: 0.2 });
    // roles, grants and usage still point at the same model rows
    const joined = await db.query(
      `select r.handle, p.name from roles r join model_configs m on m.id = r.model_config_id
         join model_providers p on p.id = m.provider_id`,
    );
    expect(joined.rows).toEqual([{ handle: "dev", name: "prod gpt" }]);
    expect((await db.query("select resource_id from grants")).rows).toEqual([{ resource_id: "mdl_aaaa" }]);
    // a model id is unique per provider, and deleting a provider takes its models with it
    await expect(
      db.exec(
        "insert into model_configs (id, provider_id, model, name) values ('mdl_c', 'prv_bbbb', 'claude-x', 'dup')",
      ),
    ).rejects.toThrow();
    await db.exec("delete from model_providers where id = 'prv_bbbb'");
    expect((await db.query("select id from model_configs")).rows).toEqual([{ id: "mdl_aaaa" }]);
    await db.close();
  });
});

describe("0003_drop_external_runtime", () => {
  it("disables external-agent roles and cancels their unfinished tasks", async () => {
    const db = new PGlite();
    for (const tag of ["0000_init", "0001_inbound_queue", "0002_model_providers"]) await apply(db, tag);
    await db.exec(`
      insert into roles (id, name, handle, runtime, runtime_config)
        values ('role_ext', 'Coder', 'coder', 'external', '{"command":"agent"}'), ('role_own', 'Dev', 'dev', 'witden', '{}');
      insert into topics (id, title) values ('top_1', 't');
      insert into tasks (id, topic_id, title, owner_role_id, runtime, status)
        values ('task_1', 'top_1', 'a', 'role_ext', 'external', 'running'),
               ('task_2', 'top_1', 'b', 'role_ext', 'external', 'completed'),
               ('task_3', 'top_1', 'c', 'role_own', 'witden', 'running');
    `);
    await apply(db, "0003_drop_external_runtime");
    expect((await db.query("select handle, status from roles order by handle")).rows).toEqual([
      { handle: "coder", status: "disabled" },
      { handle: "dev", status: "active" },
    ]);
    expect((await db.query("select id, status from tasks order by id")).rows).toEqual([
      { id: "task_1", status: "cancelled" },
      { id: "task_2", status: "completed" },
      { id: "task_3", status: "running" },
    ]);
    const cols = await db.query(
      "select table_name, column_name from information_schema.columns where table_name in ('roles', 'tasks') and column_name in ('runtime', 'runtime_config')",
    );
    expect(cols.rows).toEqual([]);
    await db.close();
  });
});

describe("0010_dm_always_open", () => {
  it("keeps one open DM per person, role and source, and drops the DM prefix from titles", async () => {
    const db = new PGlite();
    const tags = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0010")
      .sort();
    for (const f of tags) await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into topics (id, title, kind, status, source, last_message_at, created_at) values
        -- archived and then reopened from the sidebar: an empty second DM was started
        ('top_old', 'DM alice · dev', 'dm', 'archived', 'internal', now() - interval '1 hour', now() - interval '2 days'),
        ('top_new', 'DM alice · dev', 'dm', 'active', 'internal', null, now() - interval '1 day'),
        -- archived alone: reopened
        ('top_lone', 'DM bob · dev', 'dm', 'archived', 'internal', now(), now()),
        -- the same pair over Slack is a separate conversation
        ('top_slack', 'DM alice · dev', 'dm', 'active', 'slack', now(), now()),
        ('top_group', 'Release', 'group', 'archived', 'internal', now(), now());
      insert into topic_participants (id, topic_id, participant_type, participant_id) values
        ('p1', 'top_old', 'user', 'alice'), ('p2', 'top_old', 'role', 'dev'),
        ('p3', 'top_new', 'user', 'alice'), ('p4', 'top_new', 'role', 'dev'),
        ('p5', 'top_lone', 'user', 'bob'), ('p6', 'top_lone', 'role', 'dev'),
        ('p7', 'top_slack', 'user', 'alice'), ('p8', 'top_slack', 'role', 'dev');
    `);
    await apply(db, "0010_dm_always_open");
    const rows = (await db.query("select id, title, status from topics order by id")).rows as any[];
    expect(rows.map((r) => [r.id, r.title, r.status])).toEqual([
      ["top_group", "Release", "archived"],
      ["top_lone", "bob · dev", "active"],
      ["top_new", "alice · dev", "archived"],
      ["top_old", "alice · dev", "active"],
      ["top_slack", "alice · dev", "active"],
    ]);
    await db.close();
  });
});

describe("0011_merge_old_dms", () => {
  it("moves an old read-only DM into the open one, rewriting labels wherever its content went", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0011")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into roles (id, name, handle) values ('dev', 'Dev', 'dev');
      insert into topics (id, title, kind, status, source, last_message_at) values
        ('top_old', 'alice · Dev', 'dm', 'archived', 'internal', now() - interval '2 days'),
        ('top_new', 'alice · Dev', 'dm', 'active', 'internal', now() - interval '1 day'),
        ('top_group', 'Release', 'group', 'active', 'internal', now());
      insert into topic_participants (id, topic_id, participant_type, participant_id) values
        ('p1', 'top_old', 'user', 'alice'), ('p2', 'top_old', 'role', 'dev'),
        ('p3', 'top_new', 'user', 'alice'), ('p4', 'top_new', 'role', 'dev');
      insert into messages (id, topic_id, author_type, author_id, content, created_at) values
        ('m1', 'top_old', 'user', 'alice', 'my salary is 12345', now() - interval '3 days'),
        ('m2', 'top_new', 'user', 'alice', 'hello again', now() - interval '1 day');
      insert into agent_sessions (id, role_id, topic_id, notes, runs) values
        ('s_old', 'dev', 'top_old', '[{"task_id":"t1","request":"old","result":"r","at":"x"}]', 1),
        ('s_new', 'dev', 'top_new', '[{"task_id":"t2","request":"new","result":"r","at":"y"}]', 2);
      insert into tasks (id, topic_id, session_id, title, owner_role_id, labels) values
        ('t1', 'top_old', 's_old', 'old task', 'dev', '["topic:top_old"]'),
        ('t3', 'top_group', null, 'read the DM', 'dev', '["topic:top_group","topic:top_old"]');
      insert into artifacts (id, name, storage_key, topic_id, labels) values ('f1', 'a.txt', 'k1', 'top_old', '["topic:top_old"]');
      insert into memories (id, scope, topic_id, content, labels) values ('mem1', 'topic', 'top_old', 'note', '["topic:top_old"]');
    `);
    await apply(db, "0011_merge_old_dms");
    const q = async (sql: string) => (await db.query(sql)).rows as any[];
    expect(await q("select id, status from topics order by id")).toEqual([
      { id: "top_group", status: "active" },
      { id: "top_new", status: "active" },
    ]);
    expect(
      (await q("select id from messages where topic_id = 'top_new' order by created_at")).map((r) => r.id),
    ).toEqual(["m1", "m2"]);
    const [session] = await q("select id, notes, runs from agent_sessions");
    expect([session.id, session.notes.map((n: any) => n.request), session.runs]).toEqual(["s_new", ["old", "new"], 3]);
    expect(await q("select id, topic_id, session_id from tasks order by id")).toEqual([
      { id: "t1", topic_id: "top_new", session_id: "s_new" },
      { id: "t3", topic_id: "top_group", session_id: null },
    ]);
    const labels = async (table: string, id: string) =>
      [...(await q(`select labels from ${table} where id = '${id}'`))[0].labels].sort();
    expect(await labels("tasks", "t1")).toEqual(["topic:top_new"]);
    expect(await labels("tasks", "t3")).toEqual(["topic:top_group", "topic:top_new"]);
    expect(await labels("artifacts", "f1")).toEqual(["topic:top_new"]);
    expect(await labels("memories", "mem1")).toEqual(["topic:top_new"]);
    expect((await q("select topic_id from artifacts"))[0].topic_id).toBe("top_new");
    await db.close();
  });
});

describe("0013_external_members", () => {
  it("marks accounts created automatically for a connection as its external members", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0013")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into users (id, name, email, password_hash) values
        ('usr_auto', 'carol', null, null),
        ('usr_given_login', 'dave', 'dave@example.com', 'hash'),
        ('usr_member', 'alice', 'alice@example.com', 'hash');
      insert into audit_logs (id, action, actor_type, connection_id, detail) values
        ('aud_1', 'identity.auto_provision', 'system', 'conn_1', '{"user_id": "usr_auto"}'),
        ('aud_2', 'identity.auto_provision', 'system', 'conn_1', '{"user_id": "usr_given_login"}');
    `);
    await apply(db, "0013_external_members");
    const rows = (await db.query("select id, external_connection_id from users order by id")).rows;
    expect(rows).toEqual([
      { id: "usr_auto", external_connection_id: "conn_1" },
      { id: "usr_given_login", external_connection_id: null },
      { id: "usr_member", external_connection_id: null },
    ]);
    await db.close();
  });
});

describe("0016_record_all_threads", () => {
  it("drops the per-conversation sync mode and the connections' default for it", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0016")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into connections (id, platform, name, settings) values
        ('conn_1', 'slack', 'acme', '{"default_sync_mode": "off", "custom_identity": true}');
      insert into external_conversations (id, connection_id, external_id, sync_mode) values
        ('conv_1', 'conn_1', 'C1', 'off');
    `);
    await apply(db, "0016_record_all_threads");
    expect((await db.query("select settings from connections")).rows).toEqual([
      { settings: { custom_identity: true } },
    ]);
    const columns = (
      await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'external_conversations'",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).not.toContain("sync_mode");
    expect((await db.query("select id from external_conversations")).rows).toEqual([{ id: "conv_1" }]);
    await db.close();
  });
});

describe("0017_slack_channel_topics", () => {
  it("merges a Slack channel's thread topics into one topic for the channel, keeping published threads", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0017")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into users (id, name) values ('usr_a', 'alice'), ('usr_b', 'bob');
      insert into roles (id, name, handle) values ('role_dev', 'Dev', 'dev');
      insert into connections (id, platform, name) values ('conn_1', 'slack', 'acme');
      insert into external_conversations (id, connection_id, external_id, kind, name) values
        ('conv_c', 'conn_1', 'C1', 'public', 'general'), ('conv_d', 'conn_1', 'D1', 'im', null);
      insert into topics (id, title, kind, source, created_by, created_at) values
        ('top_1', '#general: nihao', 'group', 'slack', 'usr_a', '2026-10-14 08:08'),
        ('top_2', '#general: 你好', 'group', 'slack', 'usr_b', '2026-10-14 08:09'),
        ('top_3', '#general: 你是谁', 'group', 'slack', 'usr_a', '2026-10-14 08:10'),
        ('top_pub', 'Release plan', 'group', 'web', 'usr_a', '2026-10-14 07:00'),
        ('top_dm', 'alice', 'dm', 'slack', 'usr_a', '2026-10-14 08:00');
      insert into external_thread_links (id, connection_id, conversation_id, thread_key, topic_id) values
        ('lnk_1', 'conn_1', 'conv_c', '100.1', 'top_1'),
        ('lnk_2', 'conn_1', 'conv_c', '200.1', 'top_2'),
        ('lnk_3', 'conn_1', 'conv_c', '300.1', 'top_3'),
        ('lnk_pub', 'conn_1', 'conv_c', '50.1', 'top_pub'),
        ('lnk_dm', 'conn_1', 'conv_d', '__dm__', 'top_dm');
      insert into topic_participants (id, topic_id, participant_type, participant_id) values
        ('tp_1', 'top_1', 'user', 'usr_a'), ('tp_2', 'top_2', 'user', 'usr_b'), ('tp_2r', 'top_2', 'role', 'role_dev'),
        ('tp_3', 'top_3', 'user', 'usr_a');
      insert into messages (id, topic_id, author_type, author_id, content, source, external_ref, created_at) values
        ('msg_1', 'top_1', 'user', 'usr_a', 'nihao', 'slack', '{"conversation": "C1", "ts": "100.1", "thread": "100.1"}', '2026-10-14 08:08'),
        ('msg_1r', 'top_1', 'role', 'role_dev', 'hi alice', 'web', null, '2026-10-14 08:08:30'),
        ('msg_2', 'top_2', 'user', 'usr_b', '你好', 'slack', '{"conversation": "C1", "ts": "200.1", "thread": "200.1"}', '2026-10-14 08:09'),
        ('msg_2b', 'top_2', 'user', 'usr_a', 'in the thread', 'slack', '{"conversation": "C1", "ts": "200.5", "thread": "200.1"}', '2026-10-14 08:09:30'),
        ('msg_3', 'top_3', 'user', 'usr_a', '你是谁', 'slack', '{"conversation": "C1", "ts": "300.1", "thread": "300.1"}', '2026-10-14 08:10'),
        ('msg_pub', 'top_pub', 'user', 'usr_a', 'plan', 'web', null, '2026-10-14 07:00');
      insert into agent_sessions (id, topic_id, role_id, notes, runs, created_at) values
        ('ses_2', 'top_2', 'role_dev', '[{"task_id": "tsk_2", "request": "你好", "result": "b", "at": "2"}]', 1, '2026-10-14 08:09'),
        ('ses_3', 'top_3', 'role_dev', '[{"task_id": "tsk_3", "request": "你是谁", "result": "c", "at": "3"}]', 1, '2026-10-14 08:10');
      insert into tasks (id, topic_id, owner_role_id, title, instruction, session_id, labels) values
        ('tsk_3', 'top_3', 'role_dev', '你是谁', '你是谁', 'ses_3', '["topic:top_3", "user:usr_a"]');
    `);
    await apply(db, "0017_slack_channel_topics");
    const q = async (sql: string) => (await db.query(sql)).rows as any[];
    // one topic for the channel, named after it; the published topic and the DM stay as they were
    expect(await q("select id, title from topics order by id")).toEqual([
      { id: "top_1", title: "#general" },
      { id: "top_dm", title: "alice" },
      { id: "top_pub", title: "Release plan" },
    ]);
    expect(await q("select thread_key, topic_id from external_thread_links order by thread_key")).toEqual([
      { thread_key: "50.1", topic_id: "top_pub" },
      { thread_key: "__channel__", topic_id: "top_1" },
      { thread_key: "__dm__", topic_id: "top_dm" },
    ]);
    // every message is in the channel topic; what was inside a thread points at its first message
    expect(
      await q("select id, topic_id, reply_to_id from messages where topic_id <> 'top_pub' order by created_at"),
    ).toEqual([
      { id: "msg_1", topic_id: "top_1", reply_to_id: null },
      { id: "msg_1r", topic_id: "top_1", reply_to_id: "msg_1" },
      { id: "msg_2", topic_id: "top_1", reply_to_id: null },
      { id: "msg_2b", topic_id: "top_1", reply_to_id: "msg_2" },
      { id: "msg_3", topic_id: "top_1", reply_to_id: null },
    ]);
    // one session for the role, with both threads' notes in order; its task follows, labels too
    const sessions = await q("select id, topic_id, runs, notes from agent_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ topic_id: "top_1", runs: 2 });
    expect(sessions[0].notes.map((n: any) => n.task_id)).toEqual(["tsk_2", "tsk_3"]);
    expect(await q("select topic_id, session_id, labels from tasks")).toEqual([
      { topic_id: "top_1", session_id: sessions[0].id, labels: expect.arrayContaining(["topic:top_1", "user:usr_a"]) },
    ]);
    // everyone who took part in a thread takes part in the channel topic
    expect(
      await q(
        "select participant_type, participant_id from topic_participants where topic_id = 'top_1' order by participant_id",
      ),
    ).toEqual([
      { participant_type: "role", participant_id: "role_dev" },
      { participant_type: "user", participant_id: "usr_a" },
      { participant_type: "user", participant_id: "usr_b" },
    ]);
    await db.close();
  });
});

describe("0026_feishu_group_topics", () => {
  it("merges a Feishu group's topics into one topic for the group; private chats and Slack stay", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0026")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into users (id, name) values ('usr_a', 'alice'), ('usr_b', 'bob');
      insert into roles (id, name, handle) values ('role_dev', 'Dev', 'dev');
      insert into connections (id, platform, name) values ('conn_f', 'feishu', 'lark'), ('conn_s', 'slack', 'acme');
      insert into external_conversations (id, connection_id, external_id, kind, name) values
        ('conv_g', 'conn_f', 'oc_group', 'private', null), ('conv_p', 'conn_f', 'oc_p2p', 'im', null),
        ('conv_s', 'conn_s', 'C1', 'public', 'general');
      insert into topics (id, title, kind, source, created_by, created_at) values
        ('top_1', '#oc_group: 你好', 'group', 'feishu', 'usr_a', '2026-10-18 08:00'),
        ('top_2', '#oc_group: 帮我看看', 'group', 'feishu', 'usr_b', '2026-10-18 08:05'),
        ('top_p', 'alice', 'dm', 'feishu', 'usr_a', '2026-10-18 07:00'),
        ('top_s', '#general', 'group', 'slack', 'usr_a', '2026-10-18 06:00');
      insert into external_thread_links (id, connection_id, conversation_id, thread_key, topic_id) values
        ('lnk_1', 'conn_f', 'conv_g', 'om_1', 'top_1'),
        ('lnk_2', 'conn_f', 'conv_g', 'om_2', 'top_2'),
        ('lnk_p', 'conn_f', 'conv_p', '__dm__', 'top_p'),
        ('lnk_s', 'conn_s', 'conv_s', '__channel__', 'top_s');
      insert into topic_participants (id, topic_id, participant_type, participant_id) values
        ('tp_1', 'top_1', 'user', 'usr_a'), ('tp_1r', 'top_1', 'role', 'role_dev'),
        ('tp_2', 'top_2', 'user', 'usr_b'), ('tp_2r', 'top_2', 'role', 'role_dev');
      insert into messages (id, topic_id, author_type, author_id, content, source, external_ref, created_at) values
        ('msg_1', 'top_1', 'user', 'usr_a', '你好', 'feishu', '{"conversation": "oc_group", "ts": "om_1", "thread": "om_1"}', '2026-10-18 08:00'),
        ('msg_1r', 'top_1', 'role', 'role_dev', '你好 alice', 'web', null, '2026-10-18 08:00:30'),
        ('msg_2', 'top_2', 'user', 'usr_b', '帮我看看', 'feishu', '{"conversation": "oc_group", "ts": "om_2", "thread": "om_2"}', '2026-10-18 08:05'),
        ('msg_2b', 'top_2', 'user', 'usr_b', '在回复里', 'feishu', '{"conversation": "oc_group", "ts": "om_3", "thread": "om_2"}', '2026-10-18 08:06'),
        ('msg_p', 'top_p', 'user', 'usr_a', '私聊', 'feishu', '{"conversation": "oc_p2p", "ts": "om_9", "thread": "__dm__"}', '2026-10-18 07:00');
      insert into agent_sessions (id, topic_id, role_id, notes, runs, created_at) values
        ('ses_1', 'top_1', 'role_dev', '[{"task_id": "tsk_1", "request": "你好", "result": "a", "at": "1"}]', 1, '2026-10-18 08:00'),
        ('ses_2', 'top_2', 'role_dev', '[{"task_id": "tsk_2", "request": "帮我看看", "result": "b", "at": "2"}]', 1, '2026-10-18 08:05');
      insert into tasks (id, topic_id, owner_role_id, title, instruction, session_id, labels) values
        ('tsk_2', 'top_2', 'role_dev', '帮我看看', '帮我看看', 'ses_2', '["topic:top_2"]');
    `);
    await apply(db, "0026_feishu_group_topics");
    const q = async (sql: string) => (await db.query(sql)).rows as any[];
    expect(await q("select id, title from topics order by id")).toEqual([
      { id: "top_1", title: "#oc_group" },
      { id: "top_p", title: "alice" },
      { id: "top_s", title: "#general" },
    ]);
    expect(await q("select thread_key, topic_id from external_thread_links order by topic_id")).toEqual([
      { thread_key: "__channel__", topic_id: "top_1" },
      { thread_key: "__dm__", topic_id: "top_p" },
      { thread_key: "__channel__", topic_id: "top_s" },
    ]);
    // the role's answer was in the reply chain of the message it answered (sent with reply_in_thread)
    expect(
      await q("select id, topic_id, reply_to_id from messages where topic_id = 'top_1' order by created_at"),
    ).toEqual([
      { id: "msg_1", topic_id: "top_1", reply_to_id: null },
      { id: "msg_1r", topic_id: "top_1", reply_to_id: "msg_1" },
      { id: "msg_2", topic_id: "top_1", reply_to_id: null },
      { id: "msg_2b", topic_id: "top_1", reply_to_id: "msg_2" },
    ]);
    const sessions = await q("select id, topic_id, runs, notes from agent_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: "ses_1", topic_id: "top_1", runs: 2 });
    expect(sessions[0].notes.map((n: any) => n.task_id)).toEqual(["tsk_1", "tsk_2"]);
    expect(await q("select topic_id, session_id, labels from tasks")).toEqual([
      { topic_id: "top_1", session_id: "ses_1", labels: ["topic:top_1"] },
    ]);
    expect(
      await q("select participant_type, participant_id from topic_participants where topic_id = 'top_1' order by 2"),
    ).toEqual([
      { participant_type: "role", participant_id: "role_dev" },
      { participant_type: "user", participant_id: "usr_a" },
      { participant_type: "user", participant_id: "usr_b" },
    ]);
    await db.close();
  });
});

describe("0018_connection_role", () => {
  async function upTo0018() {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0018")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into roles (id, name, handle) values ('role_a', 'A', 'a'), ('role_b', 'B', 'b'), ('role_c', 'C', 'c');
    `);
    return db;
  }
  const roleIds = async (db: PGlite) =>
    (
      await db.query<{ id: string; settings: Record<string, unknown> }>(
        "select id, settings from connections order by id",
      )
    ).rows;

  it("turns each connection's rules into the role its bot stands for, then drops the rules", async () => {
    const db = await upTo0018();
    await db.exec(`
      insert into connections (id, platform, name, settings) values
        ('conn_allow', 'slack', 'allow', '{}'),
        ('conn_bound', 'slack', 'bound', '{"role_id": "role_a"}'),
        ('conn_ext', 'feishu', 'ext', '{"external_role_ids": ["role_b"], "auto_provision_users": true}'),
        ('conn_gone', 'slack', 'gone', '{}'),
        ('conn_many', 'slack', 'many', '{"external_role_ids": ["role_a", "role_b"]}'),
        ('conn_rule', 'slack', 'rule', '{}');
      insert into assignment_rules (id, name, priority, match, effect, allow_role_ids, default_role_id) values
        ('rule_1', 'rule default', 10, '{"connection_id": "conn_rule"}', 'allow', null, 'role_a'),
        ('rule_2', 'rule later', 20, '{"connection_id": "conn_rule"}', 'allow', null, 'role_b'),
        ('rule_3', 'allow one', 10, '{"connection_id": "conn_allow"}', 'allow', '["role_b"]', null),
        ('rule_4', 'bound', 10, '{"connection_id": "conn_bound"}', 'allow', null, 'role_b'),
        ('rule_5', 'missing role', 10, '{"connection_id": "conn_gone"}', 'allow', null, 'role_gone'),
        ('rule_6', 'channel only', 10, '{"connection_id": "conn_many", "conversation_kind": "im"}', 'allow', null, 'role_c'),
        ('rule_7', 'several', 50, '{}', 'allow', '["role_a", "role_c"]', null);
    `);
    await apply(db, "0018_connection_role");
    expect(await roleIds(db)).toEqual([
      { id: "conn_allow", settings: { role_id: "role_b" } },
      { id: "conn_bound", settings: { role_id: "role_a" } },
      { id: "conn_ext", settings: { role_id: "role_b", auto_provision_users: true } },
      { id: "conn_gone", settings: {} },
      { id: "conn_many", settings: {} },
      { id: "conn_rule", settings: { role_id: "role_a" } },
    ]);
    const tables = (
      await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      )
    ).rows.map((r) => r.table_name);
    expect(tables).not.toContain("assignment_rules");
    await db.close();
  });

  it("gives connections without a rule of their own the role of a rule matching everything", async () => {
    const db = await upTo0018();
    await db.exec(`
      insert into connections (id, platform, name, settings) values ('conn_1', 'slack', 'acme', '{}');
      insert into assignment_rules (id, name, match, effect, enabled, default_role_id) values
        ('rule_off', 'disabled', '{}', 'allow', false, 'role_a'),
        ('rule_deny', 'deny', '{}', 'deny', true, 'role_b'),
        ('rule_all', 'everyone', '{}', 'allow', true, 'role_c');
    `);
    await apply(db, "0018_connection_role");
    expect(await roleIds(db)).toEqual([{ id: "conn_1", settings: { role_id: "role_c" } }]);
    await db.close();
  });
});

describe("0020_single_system_admin", () => {
  it("keeps the oldest system administrator; the others become ordinary roles; a second one is refused", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0020")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into roles (id, name, handle, system_admin, allowed_tools, approval_required, created_at) values
        ('role_old', 'Admin', 'admin', true, '["config"]', '[]', '2026-10-14 08:00'),
        ('role_new', 'Ops', 'ops', true, '["config", "shell"]', '["change_config", "shell"]', '2026-10-14 09:00'),
        ('role_dev', 'Dev', 'dev', false, '["shell"]', '[]', '2026-10-14 07:00');
    `);
    await apply(db, "0020_single_system_admin");
    expect(
      (await db.query("select id, system_admin, allowed_tools, approval_required from roles order by id")).rows,
    ).toEqual([
      { id: "role_dev", system_admin: false, allowed_tools: ["shell"], approval_required: [] },
      { id: "role_new", system_admin: false, allowed_tools: ["shell"], approval_required: ["shell"] },
      { id: "role_old", system_admin: true, allowed_tools: ["config"], approval_required: [] },
    ]);
    await expect(db.exec("update roles set system_admin = true where id = 'role_dev'")).rejects.toThrow();
    await db.close();
  });
});

describe("0021_role_profile_tool", () => {
  it("gives existing roles the description tool, asking first; not the system administrator", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0021")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into roles (id, name, handle, system_admin, allowed_tools, approval_required) values
        ('role_admin', 'Admin', 'admin', true, '["config"]', '[]'),
        ('role_dev', 'Dev', 'dev', false, '["shell", "topics"]', '["topics"]'),
        ('role_chat', 'Chat', 'chat', false, '[]', '[]');
    `);
    await apply(db, "0021_role_profile_tool");
    expect((await db.query("select id, allowed_tools, approval_required from roles order by id")).rows).toEqual([
      { id: "role_admin", allowed_tools: ["config"], approval_required: [] },
      { id: "role_chat", allowed_tools: ["profile"], approval_required: ["profile"] },
      { id: "role_dev", allowed_tools: ["profile", "shell", "topics"], approval_required: ["profile", "topics"] },
    ]);
    await db.close();
  });
});

describe("0022_role_settings", () => {
  it("moves job knowledge into the role prompts, drops avatars from elsewhere, adds reasoning effort", async () => {
    const db = new PGlite();
    for (const f of fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql") && f < "0022")
      .sort())
      await apply(db, f.replace(/\.sql$/, ""));
    await db.exec(`
      insert into roles (id, name, handle, system_prompt, avatar_url) values
        ('role_dev', 'Dev', 'dev', 'You build things.', 'https://img.example/a.png'),
        ('role_ops', 'Ops', 'ops', '', '/api/avatars/${"a".repeat(64)}.png'),
        ('role_qa', 'QA', 'qa', 'You test.', null);
      insert into memories (id, scope, role_id, content, created_at, deleted_at) values
        ('mem_2', 'role', 'role_dev', 'run make check before a release', '2026-10-14 09:00', null),
        ('mem_1', 'role', 'role_dev', 'staging is at staging.example', '2026-10-14 08:00', null),
        ('mem_x', 'role', 'role_dev', 'deleted note', '2026-10-14 07:00', '2026-10-14 07:30'),
        ('mem_3', 'role', 'role_ops', 'pager rota is in the wiki', '2026-10-14 08:00', null),
        ('mem_t', 'topic', 'role_dev', 'a topic note stays', '2026-10-14 08:00', null);
    `);
    await apply(db, "0022_role_settings");
    const roles = (
      await db.query<{ id: string; system_prompt: string; avatar_url: string | null; reasoning_effort: null }>(
        "select id, system_prompt, avatar_url, reasoning_effort from roles order by id",
      )
    ).rows;
    expect(roles).toEqual([
      {
        id: "role_dev",
        system_prompt:
          "You build things.\n\n## 岗位知识\n- staging is at staging.example\n- run make check before a release",
        avatar_url: null,
        reasoning_effort: null,
      },
      {
        id: "role_ops",
        system_prompt: "## 岗位知识\n- pager rota is in the wiki",
        avatar_url: `/api/avatars/${"a".repeat(64)}.png`,
        reasoning_effort: null,
      },
      { id: "role_qa", system_prompt: "You test.", avatar_url: null, reasoning_effort: null },
    ]);
    expect((await db.query("select id from memories order by id")).rows).toEqual([{ id: "mem_t" }]);
    await db.close();
  });
});

describe("0024_slack_apps", () => {
  it("turns each Slack connection that held an app into an app under its id; workspaces point at it", async () => {
    const db = new PGlite();
    const tags = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    for (const tag of tags.filter((t) => t < "0024")) await apply(db, tag);
    await db.exec(`
      insert into connections (id, platform, name, credentials_encrypted, external_workspace_id)
        values ('conn_app', 'slack', 'acme', 'v1.iv.tag.app', 'T1'),
               ('conn_hub', 'github', 'hub', 'v1.iv.tag.gh', null);
      insert into connections (id, platform, name, credentials_encrypted, external_workspace_id, install_of)
        values ('conn_beta', 'slack', 'Beta', 'v1.iv.tag.beta', 'T2', 'conn_app');
    `);
    await apply(db, "0024_slack_apps");
    await apply(db, "0025_drop_install_of");
    // the app keeps the id Slack's events URL names, and the credentials (split at start by the API)
    expect((await db.query("select id, name, credentials_encrypted from slack_apps")).rows).toEqual([
      { id: "conn_app", name: "acme", credentials_encrypted: "v1.iv.tag.app" },
    ]);
    expect((await db.query("select id, slack_app_id from connections order by id")).rows).toEqual([
      { id: "conn_app", slack_app_id: "conn_app" },
      { id: "conn_beta", slack_app_id: "conn_app" },
      { id: "conn_hub", slack_app_id: null },
    ]);
    const columns = (
      await db.query("select column_name from information_schema.columns where table_name = 'connections'")
    ).rows as { column_name: string }[];
    expect(columns.map((c) => c.column_name)).not.toContain("install_of");
    // deleting the workspace the app came from leaves the app and its other workspace
    await db.exec("delete from connections where id = 'conn_app'");
    expect((await db.query("select count(*)::int as n from slack_apps")).rows).toEqual([{ n: 1 }]);
    await db.close();
  });
});
