-- Replaced by connections.slack_app_id (0024).
ALTER TABLE "connections" DROP CONSTRAINT "connections_install_of_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "connections" DROP COLUMN "install_of";