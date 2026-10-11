ALTER TABLE "processed_events" ALTER COLUMN "status" SET DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "kind" text DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_events" ADD COLUMN "claimed_at" timestamp with time zone;