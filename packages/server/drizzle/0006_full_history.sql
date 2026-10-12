-- Everyone in a topic reads its whole history: the per-topic policy and the per-member start time are gone.
ALTER TABLE "topic_participants" DROP COLUMN "history_from";--> statement-breakpoint
ALTER TABLE "topics" DROP COLUMN "history_policy";