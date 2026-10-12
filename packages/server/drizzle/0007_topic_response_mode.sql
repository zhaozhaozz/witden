-- How roles respond moves from each role to the topic: "mention" (only when @-mentioned) or "auto" (a
-- dispatcher decides). Group topics that had a role set to answer without mentions become "auto".
CREATE TABLE "message_routes" (
	"message_id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "response_mode" text DEFAULT 'mention' NOT NULL;--> statement-breakpoint
UPDATE "topics" SET "response_mode" = 'auto' WHERE "kind" = 'group' AND "id" IN (SELECT tp."topic_id" FROM "topic_participants" tp JOIN "roles" r ON r."id" = tp."participant_id" WHERE tp."participant_type" = 'role' AND tp."removed_at" IS NULL AND r."response_mode" = 'active');--> statement-breakpoint
ALTER TABLE "message_routes" ADD CONSTRAINT "message_routes_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_message_routes_status" ON "message_routes" USING btree ("status");--> statement-breakpoint
ALTER TABLE "roles" DROP COLUMN "response_mode";