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
