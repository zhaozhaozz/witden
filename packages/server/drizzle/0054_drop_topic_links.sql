-- Topic links are gone: an AI employee works with the group topics it takes part in. What was sent through a link
-- and not taken up yet is dropped, as when a person unlinked: unread linked messages, linked messages still waiting
-- for the dispatcher, and linked publications not sent yet. Work a linked message started is checked by the
-- membership rule at its next step (agent/revocation.ts): it goes on only while the AI employee that sent it takes
-- part in both topics.
UPDATE "agent_sessions" s SET "inbox" = (
  SELECT jsonb_agg(
    CASE WHEN coalesce(e.i->>'done', '') = '' AND e.i->'topic_delivery' ? 'link_id'
      THEN e.i || jsonb_build_object('done', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ELSE e.i
    END ORDER BY e.n)
  FROM jsonb_array_elements(s."inbox") WITH ORDINALITY AS e(i, n)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(s."inbox") AS e(i)
  WHERE coalesce(e.i->>'done', '') = '' AND e.i->'topic_delivery' ? 'link_id'
);--> statement-breakpoint
UPDATE "message_routes" SET "status" = 'done', "result" = '{"skipped": true, "reason": "topic links were removed"}'::jsonb
WHERE "status" IN ('pending', 'routing')
  AND "message_id" IN (SELECT "id" FROM "messages" WHERE "source" = 'topic' AND "external_ref"->'topic_delivery' ? 'link_id');--> statement-breakpoint
UPDATE "outbound_messages" SET "status" = 'blocked', "last_error" = 'topic links were removed before publication'
WHERE "status" = 'pending'
  AND "message_id" IN (SELECT "id" FROM "messages" WHERE "source" = 'topic' AND "external_ref"->'topic_delivery' ? 'link_id');--> statement-breakpoint
DROP TABLE "topic_links" CASCADE;
