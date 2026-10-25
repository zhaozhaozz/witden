CREATE TABLE "role_skill_files" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"path" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"storage_key" text NOT NULL,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_skill_files" ADD CONSTRAINT "role_skill_files_skill_id_role_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."role_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_role_skill_file_path" ON "role_skill_files" USING btree ("skill_id","path");