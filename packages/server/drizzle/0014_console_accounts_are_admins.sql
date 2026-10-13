-- Everyone who signs in to the console is an administrator and sees every conversation; the people the
-- roles serve are outside (Slack / Feishu members, external members). Per-person grants and topic owners are
-- gone with the console's member model.
UPDATE users SET is_admin = true WHERE external_connection_id IS NULL;
--> statement-breakpoint
UPDATE users SET is_admin = false WHERE external_connection_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE "grants" CASCADE;
--> statement-breakpoint
ALTER TABLE "topic_participants" DROP COLUMN "is_owner";
