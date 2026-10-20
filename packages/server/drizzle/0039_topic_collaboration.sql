CREATE TABLE "task_inputs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"requester_user_id" text,
	"source_message_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "task_inputs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "task_iterations" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"result" text,
	"error" text,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_links" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_a_id" text NOT NULL,
	"topic_b_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"event_key" text,
	"request" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowed_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_triggers" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD COLUMN "webhook_receipt_id" text;--> statement-breakpoint
ALTER TABLE "task_inputs" ADD CONSTRAINT "task_inputs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_iterations" ADD CONSTRAINT "task_iterations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_links" ADD CONSTRAINT "topic_links_topic_a_id_topics_id_fk" FOREIGN KEY ("topic_a_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_links" ADD CONSTRAINT "topic_links_topic_b_id_topics_id_fk" FOREIGN KEY ("topic_b_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_source_id_webhook_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."webhook_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_task_inputs_pending" ON "task_inputs" USING btree ("task_id","consumed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_task_iteration" ON "task_iterations" USING btree ("task_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_topic_link_pair" ON "topic_links" USING btree ("topic_a_id","topic_b_id");--> statement-breakpoint
CREATE INDEX "ix_topic_link_b" ON "topic_links" USING btree ("topic_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_source_receipt_key" ON "webhook_receipts" USING btree ("source_id","event_key");--> statement-breakpoint
CREATE INDEX "ix_source_receipt_time" ON "webhook_receipts" USING btree ("source_id","created_at","id");--> statement-breakpoint
ALTER TABLE "topic_triggers" ADD CONSTRAINT "topic_triggers_source_id_webhook_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."webhook_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_webhook_receipt_id_webhook_receipts_id_fk" FOREIGN KEY ("webhook_receipt_id") REFERENCES "public"."webhook_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_trigger_events_receipt" ON "trigger_events" USING btree ("webhook_receipt_id");--> statement-breakpoint
-- Tasks that already finished: their result is their first delivery.
INSERT INTO "task_iterations" ("id", "task_id", "revision", "status", "result", "error", "usage", "finished_at")
SELECT 'iter_' || "id" || '_1', "id", 1, "status", "result", "error", "usage", "finished_at"
FROM "tasks" WHERE "kind" = 'task' AND "status" IN ('completed', 'failed', 'cancelled');
