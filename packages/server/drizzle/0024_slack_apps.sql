-- Slack apps become their own level: an app holds its credentials, each workspace it is installed in is a
-- connection pointing at it (slack_app_id).
CREATE TABLE "slack_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"app_id" text,
	"credentials_encrypted" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_apps_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "slack_app_id" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_slack_app_id_slack_apps_id_fk" FOREIGN KEY ("slack_app_id") REFERENCES "public"."slack_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Every Slack connection that held an app becomes that app, under the connection's id so the events URL Slack
-- has (/api/integrations/slack/<id>/events) keeps working, whatever happens to the connection. Its encrypted
-- credentials are copied whole; at start the API keeps the app's keys on the app and the bot token on the
-- connection (integrations/slack-apps.ts).
INSERT INTO "slack_apps" ("id", "name", "credentials_encrypted", "created_by", "created_at")
  SELECT "id", "name", "credentials_encrypted", "created_by", "created_at" FROM "connections"
  WHERE "platform" = 'slack' AND "install_of" IS NULL;
--> statement-breakpoint
UPDATE "connections" SET "slack_app_id" = coalesce("install_of", "id") WHERE "platform" = 'slack';
