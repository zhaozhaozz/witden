CREATE TABLE "task_updates" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"revision" integer NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text NOT NULL,
	"source_task_id" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_updates" ADD CONSTRAINT "task_updates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_task_updates_task" ON "task_updates" USING btree ("task_id","created_at");