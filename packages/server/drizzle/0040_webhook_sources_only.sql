-- Webhook triggers no longer have their own secret. Each one that had becomes a source with the trigger's id
-- and the same secret hash, so its sender keeps working (/api/hooks/<id> stays an alias of the source address).
INSERT INTO "webhook_sources" ("id", "name", "token_hash", "created_by", "created_at")
SELECT t."id", left(t."name" || '（' || tp."title" || '）', 120), t."token_hash", t."created_by", t."created_at"
FROM "topic_triggers" t JOIN "topics" tp ON tp."id" = t."topic_id"
WHERE t."kind" = 'webhook' AND t."source_id" IS NULL AND t."token_hash" IS NOT NULL;--> statement-breakpoint
UPDATE "topic_triggers" SET "source_id" = "id"
WHERE "kind" = 'webhook' AND "source_id" IS NULL AND "token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_triggers" DROP COLUMN "token_hash";
