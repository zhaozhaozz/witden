-- The system administrator is built in and there is exactly one: the oldest stays, any others become ordinary
-- roles without the configuration tools. The platform creates it at start when there is none.
UPDATE roles r SET
  system_admin = false,
  allowed_tools = coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements_text(r.allowed_tools) AS e(t) WHERE t <> 'config'), '[]'::jsonb),
  approval_required = coalesce((SELECT jsonb_agg(t) FROM jsonb_array_elements_text(r.approval_required) AS e(t) WHERE t NOT IN ('config', 'read_config', 'change_config')), '[]'::jsonb)
WHERE r.system_admin AND r.id <> (SELECT id FROM roles WHERE system_admin ORDER BY created_at, id LIMIT 1);
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_single_system_admin" ON "roles" USING btree ("system_admin") WHERE "roles"."system_admin";
