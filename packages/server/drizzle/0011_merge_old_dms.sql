-- The read-only DMs that 0010 left archived are merged into the open DM of the same person, role and source:
-- messages, tasks, files, memories, approvals and session notes move over, and "topic:<old>" labels are
-- rewritten wherever content read from the old DM went (both DMs have the same readers). Then the old DM goes.
CREATE TEMP TABLE dm_merge AS
WITH pairs AS (
  SELECT t.id, t.status, t.source, u.participant_id AS user_id, r.participant_id AS role_id
  FROM topics t
  JOIN topic_participants u ON u.topic_id = t.id AND u.participant_type = 'user' AND u.removed_at IS NULL
  JOIN topic_participants r ON r.topic_id = t.id AND r.participant_type = 'role' AND r.removed_at IS NULL
  WHERE t.kind = 'dm'
)
SELECT o.id AS old_id, n.id AS new_id
FROM pairs o
JOIN pairs n ON n.source = o.source AND n.user_id = o.user_id AND n.role_id = o.role_id
WHERE o.status = 'archived' AND n.status = 'active';
--> statement-breakpoint
UPDATE messages SET topic_id = m.new_id FROM dm_merge m WHERE messages.topic_id = m.old_id;
--> statement-breakpoint
UPDATE tasks SET topic_id = m.new_id FROM dm_merge m WHERE tasks.topic_id = m.old_id;
--> statement-breakpoint
UPDATE message_routes SET topic_id = m.new_id FROM dm_merge m WHERE message_routes.topic_id = m.old_id;
--> statement-breakpoint
UPDATE approvals SET topic_id = m.new_id FROM dm_merge m WHERE approvals.topic_id = m.old_id;
--> statement-breakpoint
UPDATE artifacts SET topic_id = m.new_id FROM dm_merge m WHERE artifacts.topic_id = m.old_id;
--> statement-breakpoint
UPDATE memories SET topic_id = m.new_id FROM dm_merge m WHERE memories.topic_id = m.old_id;
--> statement-breakpoint
UPDATE external_thread_links SET topic_id = m.new_id FROM dm_merge m WHERE external_thread_links.topic_id = m.old_id;
--> statement-breakpoint
-- Sessions are one per role and topic: the old notes go first in the open DM's session, its tasks follow.
UPDATE agent_sessions SET notes = o.notes || agent_sessions.notes, runs = agent_sessions.runs + o.runs
FROM agent_sessions o, dm_merge m
WHERE o.topic_id = m.old_id AND agent_sessions.topic_id = m.new_id AND agent_sessions.role_id = o.role_id;
--> statement-breakpoint
UPDATE tasks SET session_id = n.id
FROM agent_sessions o, agent_sessions n, dm_merge m
WHERE tasks.session_id = o.id AND o.topic_id = m.old_id AND n.topic_id = m.new_id AND n.role_id = o.role_id;
--> statement-breakpoint
DELETE FROM agent_sessions o USING agent_sessions n, dm_merge m
WHERE o.topic_id = m.old_id AND n.topic_id = m.new_id AND n.role_id = o.role_id;
--> statement-breakpoint
UPDATE agent_sessions SET topic_id = m.new_id FROM dm_merge m WHERE agent_sessions.topic_id = m.old_id;
--> statement-breakpoint
UPDATE tasks SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(tasks.labels) AS e(l) LEFT JOIN dm_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(tasks.labels) AS e(l) JOIN dm_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
UPDATE artifacts SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(artifacts.labels) AS e(l) LEFT JOIN dm_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(artifacts.labels) AS e(l) JOIN dm_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
UPDATE memories SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(memories.labels) AS e(l) LEFT JOIN dm_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(memories.labels) AS e(l) JOIN dm_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
UPDATE topics SET last_message_at = (SELECT max(created_at) FROM messages WHERE messages.topic_id = topics.id)
WHERE id IN (SELECT new_id FROM dm_merge);
--> statement-breakpoint
DELETE FROM topics USING dm_merge m WHERE topics.id = m.old_id;
--> statement-breakpoint
DROP TABLE dm_merge;
