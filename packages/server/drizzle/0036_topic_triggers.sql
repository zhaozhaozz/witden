CREATE TABLE "topic_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"role_id" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"token_hash" text,
	"filter_code" text DEFAULT '' NOT NULL,
	"cron" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"trigger_id" text NOT NULL,
	"trigger_name" text NOT NULL,
	"kind" text NOT NULL,
	"event_key" text,
	"config" jsonb NOT NULL,
	"request" jsonb,
	"scheduled_at" timestamp with time zone,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" text,
	"message_id" text,
	"task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "work_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "topic_triggers" ADD CONSTRAINT "topic_triggers_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_events" ADD CONSTRAINT "trigger_events_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_topic_triggers_due" ON "topic_triggers" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "ix_topic_triggers_topic" ON "topic_triggers" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_trigger_event_key" ON "trigger_events" USING btree ("trigger_id","event_key");--> statement-breakpoint
CREATE INDEX "ix_trigger_events_topic" ON "trigger_events" USING btree ("topic_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ix_trigger_events_queue" ON "trigger_events" USING btree ("status","claimed_at");