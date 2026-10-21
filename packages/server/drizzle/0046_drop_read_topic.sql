-- No tool reads another topic any more: a role learns of one by taking part in it, through a link, or from a
-- colleague it talks to directly. The "topics" group (read_topic) is gone, with any approval asked for it.
UPDATE "roles"
SET "allowed_tools" = "allowed_tools" - 'topics', "approval_required" = "approval_required" - 'topics' - 'read_topic'
WHERE "allowed_tools" @> '["topics"]'::jsonb
  OR "approval_required" @> '["topics"]'::jsonb
  OR "approval_required" @> '["read_topic"]'::jsonb;
