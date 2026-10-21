-- A topic is configured with a name and a goal only. Work instructions move into the goal (after it, when both
-- are set); the per-topic round limit and model list go: the global WITDEN_MAX_AUTO_ROUNDS and each role's own
-- model apply everywhere.
UPDATE "topics" SET "goal" = CASE WHEN "goal" = '' THEN "work_instructions" ELSE "goal" || E'\n\n' || "work_instructions" END
WHERE "work_instructions" <> '';--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "work_instructions";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "max_auto_rounds";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "allowed_model_config_ids";
