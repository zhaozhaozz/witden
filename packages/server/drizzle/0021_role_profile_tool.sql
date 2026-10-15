-- Roles may rewrite their own description (tool group "profile"), asking a person first. Existing roles get it
-- like new ones do; the built-in system administrator keeps only its configuration tools.
UPDATE roles SET
  allowed_tools = (SELECT jsonb_agg(t ORDER BY t) FROM (SELECT jsonb_array_elements_text(allowed_tools || '["profile"]'::jsonb) AS t UNION SELECT 'profile') AS u),
  approval_required = (SELECT jsonb_agg(t ORDER BY t) FROM (SELECT jsonb_array_elements_text(approval_required || '["profile"]'::jsonb) AS t UNION SELECT 'profile') AS u)
WHERE NOT system_admin;
