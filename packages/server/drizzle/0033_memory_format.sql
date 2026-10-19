-- Notes get a format: a title, keywords and the content; and a time when last changed.
ALTER TABLE "memories" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
-- Existing notes are titled by their first line (at most 60 characters); their keywords start empty.
UPDATE memories SET title = left(btrim(split_part(btrim(content), E'\n', 1)), 60)
WHERE title = '' AND deleted_at IS NULL;
