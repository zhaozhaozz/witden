-- Topics are no longer published to an external channel: internal topics that were go back to being only
-- console topics, and what had not been sent to the channel yet is not sent.
DELETE FROM "outbound_messages" o USING "messages" m, "topics" t
  WHERE o."message_id" = m."id" AND m."topic_id" = t."id" AND t."source" = 'internal' AND o."status" <> 'sent';
--> statement-breakpoint
DELETE FROM "external_thread_links" l USING "topics" t
  WHERE l."topic_id" = t."id" AND t."source" = 'internal';
--> statement-breakpoint
-- A Slack, Feishu or GitHub conversation has one role: the one its connection's bot stands for.
UPDATE "topic_participants" p SET "removed_at" = now()
  FROM "external_thread_links" l, "connections" c
  WHERE p."topic_id" = l."topic_id" AND c."id" = l."connection_id"
    AND p."participant_type" = 'role' AND p."removed_at" IS NULL
    AND p."participant_id" IS DISTINCT FROM c."settings"->>'role_id';
--> statement-breakpoint
UPDATE "topic_triggers" g SET "enabled" = false, "next_run_at" = NULL
  FROM "external_thread_links" l, "connections" c
  WHERE g."topic_id" = l."topic_id" AND c."id" = l."connection_id"
    AND g."role_id" IS DISTINCT FROM c."settings"->>'role_id';
--> statement-breakpoint
UPDATE "topics" SET "response_mode" = 'mention' WHERE "source" <> 'internal' AND "response_mode" <> 'mention';
--> statement-breakpoint
DELETE FROM "message_routes" r USING "topics" t
  WHERE r."topic_id" = t."id" AND t."source" <> 'internal' AND r."status" IN ('pending', 'routing');
--> statement-breakpoint
-- Other roles no longer speak there under their own name.
UPDATE "connections" SET "settings" = "settings" - 'custom_identity' WHERE "settings" ? 'custom_identity';
