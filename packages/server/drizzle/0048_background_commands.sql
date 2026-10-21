-- Commands run with run_command and how they ended: a timeout no longer kills them, and the end of one that
-- outlives the call reaches the work that started it as a notice.
CREATE TABLE "background_commands" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"role_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"task_id" text NOT NULL,
	"command" text NOT NULL,
	"cwd" text,
	"log_path" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"background" boolean DEFAULT false NOT NULL,
	"foreground_until" timestamp with time zone,
	"exit_code" integer,
	"signal" text,
	"output_bytes" integer,
	"tail" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"notified_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_commands" ADD CONSTRAINT "background_commands_instance_id_computer_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."computer_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_commands" ADD CONSTRAINT "background_commands_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_background_commands_instance" ON "background_commands" USING btree ("instance_id","status");--> statement-breakpoint
CREATE INDEX "ix_background_commands_task" ON "background_commands" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_background_commands_untold" ON "background_commands" USING btree ("task_id") WHERE "background_commands"."notified_at" is null;