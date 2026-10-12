-- The platform no longer starts agents inside computers. Roles that did so have no model and a prompt
-- written for another program: they are disabled rather than silently turned into platform agents.
UPDATE "roles" SET "status" = 'disabled' WHERE "runtime" = 'external';--> statement-breakpoint
-- Unfinished work of such roles cannot continue.
UPDATE "tasks" SET "status" = 'cancelled', "status_reason" = 'external agent runtime removed'
WHERE "runtime" = 'external' AND "status" NOT IN ('completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "runtime";--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "runtime_config";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "runtime";
