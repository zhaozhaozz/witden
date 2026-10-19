CREATE TABLE "feishu_calendar_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"calendar_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feishu_calendar_shares" ADD CONSTRAINT "feishu_calendar_shares_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_feishu_calendar_share" ON "feishu_calendar_shares" USING btree ("connection_id","calendar_id","chat_id");