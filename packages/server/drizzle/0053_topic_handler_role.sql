-- A Slack, Feishu or GitHub conversation may have its own handling role, chosen in its topic's settings. Null, as
-- for every existing topic, follows the role of the connection's bot.
ALTER TABLE "topics" ADD COLUMN "handler_role_id" text;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_handler_role_id_roles_id_fk" FOREIGN KEY ("handler_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;