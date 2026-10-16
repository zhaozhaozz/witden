-- Slack: a workspace added to the app another connection holds (OAuth installation), see connections.install_of.
ALTER TABLE "connections" ADD COLUMN "install_of" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_install_of_connections_id_fk" FOREIGN KEY ("install_of") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;