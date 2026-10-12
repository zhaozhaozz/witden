ALTER TABLE "computer_instances" ADD COLUMN "model_proxy_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_instances" ADD COLUMN "model_proxy_model_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_instances" ADD COLUMN "model_proxy_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "computer_instances" ADD COLUMN "model_proxy_key_issued_at" timestamp with time zone;