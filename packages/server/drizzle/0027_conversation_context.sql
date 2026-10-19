-- A role's conversation in a topic keeps one model context (agent_sessions + task_steps.session_seq), and
-- messages arriving while it works are fed into the open run instead of starting parallel tasks. Existing
-- tasks stay kind 'task' (each with its own context); their session notes seed the first conversation run.
-- Models get a context window and compaction threshold; usage records keep how much came from a prompt cache.
ALTER TABLE "agent_sessions" ADD COLUMN "inbox" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "cursor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "wake_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "awaiting" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "context_from" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "context_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "compactions" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "roster" text;--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "compact_tokens" integer;--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN "session_seq" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "report_session_id" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "cached_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_steps_session" ON "task_steps" USING btree ("session_id","session_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_tasks_open_conversation" ON "tasks" USING btree ("session_id") WHERE kind = 'conversation' and status not in ('completed', 'failed', 'cancelled');