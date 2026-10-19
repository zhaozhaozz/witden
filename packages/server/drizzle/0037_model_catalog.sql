CREATE TABLE "model_catalog" (
	"id" text PRIMARY KEY NOT NULL,
	"source_url" text NOT NULL,
	"data" jsonb NOT NULL,
	"providers" integer NOT NULL,
	"models" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"fetched_by" text
);
--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "catalog" jsonb;