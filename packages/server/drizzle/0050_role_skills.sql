CREATE TABLE "role_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" text,
	"updated_by_type" text NOT NULL,
	"updated_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "role_skills" ADD CONSTRAINT "role_skills_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_role_skill_name" ON "role_skills" USING btree ("role_id","name") WHERE "role_skills"."deleted_at" is null;--> statement-breakpoint
-- AI employees may create and change their own skills: the new "skills" group is allowed (without asking) for every
-- existing role but the system administrator, which has no skills.
UPDATE "roles" SET "allowed_tools" = "allowed_tools" || '["skills"]'::jsonb
WHERE NOT "system_admin" AND NOT "allowed_tools" ? 'skills';
