-- Material is no longer tracked by source: what a role may read (its permissions) it may use wherever it works.
-- The information-flow labels on conversations, tasks, files and notes go. Messages already held for disclosure
-- approval stay decidable (approving posts them).
ALTER TABLE "agent_sessions" DROP COLUMN "labels";--> statement-breakpoint
ALTER TABLE "artifacts" DROP COLUMN "labels";--> statement-breakpoint
ALTER TABLE "memories" DROP COLUMN "labels";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "labels";