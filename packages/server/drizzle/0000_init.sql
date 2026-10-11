CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runs" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text DEFAULT 'session' NOT NULL,
	"name" text,
	"expires_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"role_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approver_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"sha256" text DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"kind" text DEFAULT 'upload' NOT NULL,
	"topic_id" text,
	"task_id" text,
	"instance_id" text,
	"created_by_type" text DEFAULT 'user' NOT NULL,
	"created_by_id" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assignment_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effect" text DEFAULT 'allow' NOT NULL,
	"allow_role_ids" jsonb,
	"deny_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_role_id" text,
	"allow_instance_ids" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"topic_id" text,
	"task_id" text,
	"role_id" text,
	"instance_id" text,
	"connection_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"status_reason" text,
	"container_id" text,
	"volumes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused_ai" boolean DEFAULT false NOT NULL,
	"runner_token_hash" text,
	"runner_connected_at" timestamp with time zone,
	"runner_info" jsonb,
	"last_started_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_instances_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "computer_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"image" text NOT NULL,
	"kind" text DEFAULT 'shell' NOT NULL,
	"workdir" text DEFAULT '/home/witden' NOT NULL,
	"user" text DEFAULT 'witden' NOT NULL,
	"command" jsonb,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"persistent_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"software" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_resources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cap_add" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"runtime" text,
	"desktop" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "computer_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"external_workspace_id" text,
	"bot_user_id" text,
	"credentials_encrypted" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"status_reason" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "exec_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"kind" text NOT NULL,
	"runner_session_id" text NOT NULL,
	"mode" text DEFAULT 'desktop' NOT NULL,
	"task_id" text,
	"role_id" text,
	"title" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text DEFAULT 'public' NOT NULL,
	"name" text,
	"sync_mode" text DEFAULT 'mentions' NOT NULL,
	"member_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"members_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"user_id" text,
	"display_name" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_thread_links" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"thread_key" text NOT NULL,
	"topic_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text DEFAULT '*' NOT NULL,
	"permission" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text DEFAULT '*' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"image_ref" text,
	"archives" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"includes_credentials" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"note" text,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_leases" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"kind" text DEFAULT 'input' NOT NULL,
	"holder_type" text NOT NULL,
	"holder_id" text NOT NULL,
	"task_id" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kill_switches" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target_id" text,
	"reason" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_spaces_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"role_id" text,
	"space_id" text,
	"topic_id" text,
	"user_id" text,
	"content" text NOT NULL,
	"source_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_type" text DEFAULT 'user' NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"content" text DEFAULT '' NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to_id" text,
	"task_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text DEFAULT 'web' NOT NULL,
	"external_ref" jsonb,
	"round" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text DEFAULT 'openai' NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_encrypted" text,
	"key_updated_at" timestamp with time zone,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'unchecked' NOT NULL,
	"daily_token_limit" integer,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_configs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "outbound_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"conversation_external_id" text NOT NULL,
	"thread_key" text,
	"message_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"event_key" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"handle" text NOT NULL,
	"avatar_url" text,
	"description" text DEFAULT '' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"model_config_id" text,
	"model_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"instance_id" text,
	"runtime" text DEFAULT 'witden' NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge_space_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"response_mode" text DEFAULT 'mention' NOT NULL,
	"max_steps" integer,
	"max_tokens_per_task" integer,
	"daily_token_limit" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_handle_unique" UNIQUE("handle")
);
--> statement-breakpoint
CREATE TABLE "task_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"session_id" text,
	"title" text NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"requester_user_id" text,
	"requester_role_id" text,
	"source_message_id" text,
	"owner_role_id" text NOT NULL,
	"collaborator_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"instance_id" text,
	"runtime" text DEFAULT 'witden' NOT NULL,
	"parent_task_id" text,
	"spawned_by_task_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"round" integer DEFAULT 0 NOT NULL,
	"envelope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"role_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"assignment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wait" jsonb,
	"progress" text,
	"result" text,
	"error" text,
	"idempotency_key" text,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"op" text NOT NULL,
	"state" text DEFAULT 'dispatched' NOT NULL,
	"read_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "topic_participants" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"participant_type" text NOT NULL,
	"participant_id" text NOT NULL,
	"is_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"history_from" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"invited_by" text
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"goal" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'group' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"history_policy" text DEFAULT 'since_join' NOT NULL,
	"max_auto_rounds" integer,
	"allowed_model_config_ids" jsonb,
	"source" text DEFAULT 'internal' NOT NULL,
	"created_by" text,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"role_id" text,
	"instance_id" text,
	"model_config_id" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"avatar_url" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_sessions" ADD CONSTRAINT "api_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_instances" ADD CONSTRAINT "computer_instances_template_id_computer_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."computer_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exec_sessions" ADD CONSTRAINT "exec_sessions_instance_id_computer_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."computer_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_conversations" ADD CONSTRAINT "external_conversations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_links" ADD CONSTRAINT "external_thread_links_conversation_id_external_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."external_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_thread_links" ADD CONSTRAINT "external_thread_links_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_leases" ADD CONSTRAINT "instance_leases_instance_id_computer_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."computer_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_instance_id_computer_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."computer_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_role_id_roles_id_fk" FOREIGN KEY ("owner_role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_participants" ADD CONSTRAINT "topic_participants_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_session" ON "agent_sessions" USING btree ("role_id","topic_id");--> statement-breakpoint
CREATE INDEX "ix_api_sessions_user" ON "api_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_artifacts_topic" ON "artifacts" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "ix_audit_time" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ix_audit_task" ON "audit_logs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_audit_action" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "ix_exec_sessions_instance" ON "exec_sessions" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_external_conversation" ON "external_conversations" USING btree ("connection_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_external_identity" ON "external_identities" USING btree ("connection_id","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_thread_link" ON "external_thread_links" USING btree ("conversation_id","thread_key");--> statement-breakpoint
CREATE INDEX "ix_thread_link_topic" ON "external_thread_links" USING btree ("topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_grants" ON "grants" USING btree ("subject_type","subject_id","permission","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "ix_grants_permission" ON "grants" USING btree ("permission");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_lease" ON "instance_leases" USING btree ("instance_id","kind");--> statement-breakpoint
CREATE INDEX "ix_messages_topic_time" ON "messages" USING btree ("topic_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_messages_task" ON "messages" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_processed_event" ON "processed_events" USING btree ("connection_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_steps_task_seq" ON "task_steps" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "ix_tasks_status" ON "tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ix_tasks_topic" ON "tasks" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_parent" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "ix_tasks_spawned" ON "tasks" USING btree ("spawned_by_task_id");--> statement-breakpoint
CREATE INDEX "ix_tool_calls_task" ON "tool_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "ix_participant_lookup" ON "topic_participants" USING btree ("topic_id","participant_type","participant_id");--> statement-breakpoint
CREATE INDEX "ix_usage_time" ON "usage_records" USING btree ("created_at");