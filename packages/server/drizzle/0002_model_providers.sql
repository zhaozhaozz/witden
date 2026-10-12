-- Model services become providers (endpoint, protocol, key) offering any number of models.
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text DEFAULT 'openai' NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text,
	"key_updated_at" timestamp with time zone,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"status_detail" text,
	"models_fetched_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
-- Each existing configuration becomes a provider with one model. The model keeps its id, so roles, grants,
-- usage records and topic restrictions still point at it.
INSERT INTO "model_providers" ("id", "name", "protocol", "base_url", "api_key_encrypted", "key_updated_at", "status", "created_by", "created_at")
SELECT regexp_replace("id", '^[^_]*_', 'prv_'), "name", "provider", "base_url", "api_key_encrypted", "key_updated_at",
	CASE WHEN "status" = 'revoked' THEN 'revoked' ELSE 'unchecked' END, "created_by", "created_at"
FROM "model_configs";
--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "provider_id" text;
--> statement-breakpoint
UPDATE "model_configs" SET
	"provider_id" = regexp_replace("id", '^[^_]*_', 'prv_'),
	"status" = CASE WHEN "status" = 'revoked' THEN 'unchecked' ELSE "status" END;
--> statement-breakpoint
ALTER TABLE "model_configs" ALTER COLUMN "provider_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_configs" DROP CONSTRAINT "model_configs_name_unique";
--> statement-breakpoint
ALTER TABLE "model_configs" DROP COLUMN "provider";
--> statement-breakpoint
ALTER TABLE "model_configs" DROP COLUMN "base_url";
--> statement-breakpoint
ALTER TABLE "model_configs" DROP COLUMN "api_key_encrypted";
--> statement-breakpoint
ALTER TABLE "model_configs" DROP COLUMN "key_updated_at";
--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_model_per_provider" ON "model_configs" USING btree ("provider_id","model");
