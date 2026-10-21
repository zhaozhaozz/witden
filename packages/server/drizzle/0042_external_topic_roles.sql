-- A Slack, Feishu or GitHub conversation has one role at work: the one its connection's bot stands for. Roles left
-- over from an earlier choice of role leave the linked topics, and the current role joins them.
UPDATE "topic_participants" p SET "removed_at" = now()
WHERE p."participant_type" = 'role'
  AND p."removed_at" IS NULL
  AND EXISTS (SELECT 1 FROM "external_thread_links" l WHERE l."topic_id" = p."topic_id")
  AND NOT EXISTS (
    SELECT 1 FROM "external_thread_links" l JOIN "connections" c ON c."id" = l."connection_id"
    WHERE l."topic_id" = p."topic_id" AND c."settings"->>'role_id' = p."participant_id"
  );--> statement-breakpoint
INSERT INTO "topic_participants" ("id", "topic_id", "participant_type", "participant_id")
SELECT 'tp_' || substr(md5(random()::text || b."topic_id" || b."role_id"), 1, 14), b."topic_id", 'role', b."role_id"
FROM (
  SELECT DISTINCT l."topic_id", c."settings"->>'role_id' AS "role_id"
  FROM "external_thread_links" l JOIN "connections" c ON c."id" = l."connection_id"
  WHERE coalesce(c."settings"->>'role_id', '') <> ''
) b
WHERE EXISTS (SELECT 1 FROM "roles" r WHERE r."id" = b."role_id")
  AND NOT EXISTS (
    SELECT 1 FROM "topic_participants" p
    WHERE p."topic_id" = b."topic_id" AND p."participant_type" = 'role' AND p."participant_id" = b."role_id"
      AND p."removed_at" IS NULL
  );
