-- Every thread of a conversation the bot is in is recorded; only messages addressed to the bot reach roles.
ALTER TABLE "external_conversations" DROP COLUMN "sync_mode";--> statement-breakpoint
UPDATE "connections" SET "settings" = "settings" - 'default_sync_mode';
