-- Roles: a reasoning effort setting (null: the model's default).
ALTER TABLE "roles" ADD COLUMN "reasoning_effort" text;
--> statement-breakpoint
-- Job knowledge per role is gone: what each role kept there is appended to its prompt (in the order it was
-- written), and the notes are deleted.
UPDATE roles r SET
  system_prompt = rtrim(r.system_prompt) || CASE WHEN rtrim(r.system_prompt) = '' THEN '' ELSE E'\n\n' END || E'## 岗位知识\n' || k.items,
  config_version = r.config_version + 1
FROM (
  SELECT role_id, string_agg('- ' || content, E'\n' ORDER BY created_at, id) AS items
  FROM memories
  WHERE scope = 'role' AND deleted_at IS NULL AND role_id IS NOT NULL AND content <> ''
  GROUP BY role_id
) k
WHERE r.id = k.role_id;
--> statement-breakpoint
DELETE FROM memories WHERE scope = 'role';
--> statement-breakpoint
-- Avatars are uploaded only: addresses elsewhere are dropped (the role falls back to its initials).
UPDATE roles SET avatar_url = NULL WHERE avatar_url IS NOT NULL AND avatar_url NOT LIKE '/api/avatars/%';
