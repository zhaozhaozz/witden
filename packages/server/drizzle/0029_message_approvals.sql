ALTER TABLE "messages" ADD COLUMN "approval_id" text;
--> statement-breakpoint
-- Old requests were plain system notices. Match each to the most recent approval in that run,
-- before its next approval, so repeated calls of the same tool keep their own decisions.
WITH matches AS (
  SELECT m.id AS message_id, a.id AS approval_id,
    row_number() OVER (PARTITION BY a.id ORDER BY m.created_at, m.id) AS position
  FROM approvals a
  JOIN messages m ON m.task_id = a.task_id AND m.topic_id = a.topic_id
    AND m.author_type = 'system' AND m.deleted_at IS NULL
    AND m.created_at >= a.created_at
  WHERE (
    (a.action <> 'disclose' AND m.content LIKE '@%'
      AND strpos(m.content, ' asks for approval to use ' || a.action || ':') > 0)
    OR (a.action <> 'disclose' AND m.content LIKE '@%'
      AND strpos(m.content, ' asks for approval to use ' || a.action || ' (') > 0)
    OR (a.action = 'disclose' AND m.content LIKE 'A message from @% is on hold:%')
  ) AND NOT EXISTS (
    SELECT 1 FROM approvals next
    WHERE next.task_id = a.task_id AND next.created_at > a.created_at AND next.created_at <= m.created_at
  )
)
UPDATE messages m SET approval_id = matches.approval_id
FROM matches WHERE m.id = matches.message_id AND matches.position = 1;
