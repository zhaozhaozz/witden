-- A topic link joins an external conversation (Slack, Feishu, GitHub) and an internal topic. Links between two
-- external or two internal topics are removed as if unlinked: linked messages not read yet are dropped here, and
-- tasks started from such a link end at their next step (the link is checked at run time).
WITH "removed" AS (
  DELETE FROM "topic_links" k
  WHERE EXISTS (SELECT 1 FROM "external_thread_links" l WHERE l."topic_id" = k."topic_a_id")
      = EXISTS (SELECT 1 FROM "external_thread_links" l WHERE l."topic_id" = k."topic_b_id")
  RETURNING k."id"
)
UPDATE "agent_sessions" s SET "inbox" = (
  SELECT jsonb_agg(
    CASE WHEN coalesce(e.i->>'done', '') = '' AND e.i->'topic_delivery'->>'link_id' IN (SELECT "id" FROM "removed")
      THEN e.i || jsonb_build_object('done', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ELSE e.i
    END ORDER BY e.n)
  FROM jsonb_array_elements(s."inbox") WITH ORDINALITY AS e(i, n)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(s."inbox") AS e(i)
  WHERE coalesce(e.i->>'done', '') = '' AND e.i->'topic_delivery'->>'link_id' IN (SELECT "id" FROM "removed")
);--> statement-breakpoint
-- Work goes only to roles of the topic it is in, so the permission to delegate outside the topic is gone.
UPDATE "roles"
SET "allowed_tools" = "allowed_tools" - 'collaborate', "approval_required" = "approval_required" - 'collaborate'
WHERE "allowed_tools" @> '["collaborate"]'::jsonb OR "approval_required" @> '["collaborate"]'::jsonb;--> statement-breakpoint
-- Work in a Slack, Feishu or GitHub conversation is marked as such: only there are @-mentions and delegation not
-- offered (work relayed from there into a console topic may involve that topic's roles).
UPDATE "tasks" t SET "envelope" = t."envelope" || '{"external_topic": true}'::jsonb
WHERE EXISTS (SELECT 1 FROM "external_thread_links" l WHERE l."topic_id" = t."topic_id")
  AND NOT t."envelope" @> '{"external_topic": true}'::jsonb;
