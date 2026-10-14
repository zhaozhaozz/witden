-- Assignment rules are gone: a connection's bot stands for one role (settings.role_id). A connection without one
-- takes the role its rules gave every request: the default (or single allowed) role of an enabled allow rule for
-- that connection, else of one matching everything. Failing that, the single role its external members could use.
UPDATE connections c SET settings = c.settings || jsonb_build_object('role_id', pick.role_id)
FROM (
  SELECT DISTINCT ON (k.id) k.id AS connection_id, coalesce(r.default_role_id, r.allow_role_ids->>0) AS role_id
  FROM connections k
  JOIN assignment_rules r ON r.enabled AND r.effect = 'allow'
    AND (r.match = '{}'::jsonb OR (r.match - 'connection_id' = '{}'::jsonb AND r.match->>'connection_id' = k.id))
    AND (r.default_role_id IS NOT NULL OR CASE WHEN jsonb_typeof(r.allow_role_ids) = 'array'
      THEN jsonb_array_length(r.allow_role_ids) = 1 ELSE false END)
  JOIN roles ro ON ro.id = coalesce(r.default_role_id, r.allow_role_ids->>0)
  ORDER BY k.id, r.match ? 'connection_id' DESC, r.priority, r.created_at
) pick
WHERE c.id = pick.connection_id AND coalesce(c.settings->>'role_id', '') = '';
--> statement-breakpoint
UPDATE connections c SET settings = c.settings || jsonb_build_object('role_id', c.settings->'external_role_ids'->>0)
WHERE coalesce(c.settings->>'role_id', '') = ''
  AND CASE WHEN jsonb_typeof(c.settings->'external_role_ids') = 'array'
    THEN jsonb_array_length(c.settings->'external_role_ids') = 1 ELSE false END
  AND EXISTS (SELECT 1 FROM roles WHERE roles.id = c.settings->'external_role_ids'->>0);
--> statement-breakpoint
-- External members use exactly the connection's role now.
UPDATE connections SET settings = settings - 'external_role_ids' WHERE settings ? 'external_role_ids';
--> statement-breakpoint
DROP TABLE "assignment_rules" CASCADE;
