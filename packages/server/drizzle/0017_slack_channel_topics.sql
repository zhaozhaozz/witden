-- A Slack channel becomes one topic, as Slack shows it. The topics witden made for single threads of a channel
-- merge into the channel's first one: messages, tasks, files, memories, approvals, sessions, participants and
-- "topic:<old>" labels move over (all had the channel's readers). Messages that were inside a thread point at
-- its first message. Internal topics published into a channel keep their own thread.
CREATE TEMP TABLE channel_topics AS
SELECT DISTINCT ON (l.conversation_id) l.conversation_id, l.topic_id AS new_id
FROM external_thread_links l
JOIN external_conversations c ON c.id = l.conversation_id
JOIN connections k ON k.id = c.connection_id
JOIN topics t ON t.id = l.topic_id
WHERE k.platform = 'slack' AND c.kind <> 'im' AND t.source = 'slack'
ORDER BY l.conversation_id, t.created_at, t.id;
--> statement-breakpoint
CREATE TEMP TABLE channel_merge AS
SELECT DISTINCT l.topic_id AS old_id, ct.new_id
FROM external_thread_links l
JOIN channel_topics ct ON ct.conversation_id = l.conversation_id
JOIN topics t ON t.id = l.topic_id
WHERE t.source = 'slack' AND l.topic_id <> ct.new_id;
--> statement-breakpoint
-- Each of those topics was one thread: everything in it but its first message was a reply in that thread.
UPDATE messages m SET reply_to_id = r.id
FROM external_thread_links l
JOIN channel_topics ct ON ct.conversation_id = l.conversation_id
JOIN topics t ON t.id = l.topic_id AND t.source = 'slack'
JOIN messages r ON r.topic_id = l.topic_id AND r.external_ref->>'ts' = l.thread_key
WHERE m.topic_id = l.topic_id AND m.id <> r.id AND m.reply_to_id IS NULL;
--> statement-breakpoint
UPDATE messages SET topic_id = m.new_id FROM channel_merge m WHERE messages.topic_id = m.old_id;
--> statement-breakpoint
UPDATE tasks SET topic_id = m.new_id FROM channel_merge m WHERE tasks.topic_id = m.old_id;
--> statement-breakpoint
UPDATE message_routes SET topic_id = m.new_id FROM channel_merge m WHERE message_routes.topic_id = m.old_id;
--> statement-breakpoint
UPDATE approvals SET topic_id = m.new_id FROM channel_merge m WHERE approvals.topic_id = m.old_id;
--> statement-breakpoint
UPDATE artifacts SET topic_id = m.new_id FROM channel_merge m WHERE artifacts.topic_id = m.old_id;
--> statement-breakpoint
UPDATE memories SET topic_id = m.new_id FROM channel_merge m WHERE memories.topic_id = m.old_id;
--> statement-breakpoint
UPDATE audit_logs SET topic_id = m.new_id FROM channel_merge m WHERE audit_logs.topic_id = m.old_id;
--> statement-breakpoint
UPDATE kill_switches SET target_id = m.new_id FROM channel_merge m WHERE scope = 'topic' AND target_id = m.old_id;
--> statement-breakpoint
-- People and roles of any thread take part in the channel topic.
INSERT INTO topic_participants (id, topic_id, participant_type, participant_id, created_at, removed_at, invited_by)
SELECT DISTINCT ON (m.new_id, p.participant_type, p.participant_id)
  'tp_' || substr(md5(random()::text || p.id), 1, 14), m.new_id, p.participant_type, p.participant_id,
  p.created_at, p.removed_at, p.invited_by
FROM topic_participants p
JOIN channel_merge m ON p.topic_id = m.old_id
WHERE NOT EXISTS (
  SELECT 1 FROM topic_participants n
  WHERE n.topic_id = m.new_id AND n.participant_type = p.participant_type AND n.participant_id = p.participant_id
)
ORDER BY m.new_id, p.participant_type, p.participant_id, p.removed_at NULLS FIRST, p.created_at;
--> statement-breakpoint
-- Sessions are one per role and topic. Where the channel topic has none for a role, its earliest thread
-- session moves over; the other thread sessions add their notes (in order) and runs to it, and their tasks follow.
UPDATE agent_sessions s SET topic_id = m.new_id
FROM channel_merge m
WHERE s.topic_id = m.old_id
  AND NOT EXISTS (SELECT 1 FROM agent_sessions n WHERE n.topic_id = m.new_id AND n.role_id = s.role_id)
  AND s.id = (
    SELECT o.id FROM agent_sessions o JOIN channel_merge mo ON o.topic_id = mo.old_id
    WHERE mo.new_id = m.new_id AND o.role_id = s.role_id
    ORDER BY o.created_at, o.id LIMIT 1
  );
--> statement-breakpoint
UPDATE agent_sessions s SET notes = s.notes || agg.notes, runs = s.runs + agg.runs
FROM (
  SELECT m.new_id, o.role_id, sum(o.runs) AS runs,
    coalesce((
      SELECT jsonb_agg(e.v ORDER BY o2.created_at, o2.id, e.i)
      FROM agent_sessions o2
      JOIN channel_merge m2 ON o2.topic_id = m2.old_id
      CROSS JOIN LATERAL jsonb_array_elements(o2.notes) WITH ORDINALITY AS e(v, i)
      WHERE m2.new_id = m.new_id AND o2.role_id = o.role_id
    ), '[]'::jsonb) AS notes
  FROM agent_sessions o JOIN channel_merge m ON o.topic_id = m.old_id
  GROUP BY m.new_id, o.role_id
) agg
WHERE s.topic_id = agg.new_id AND s.role_id = agg.role_id;
--> statement-breakpoint
UPDATE tasks SET session_id = n.id
FROM agent_sessions o, agent_sessions n, channel_merge m
WHERE tasks.session_id = o.id AND o.topic_id = m.old_id AND n.topic_id = m.new_id AND n.role_id = o.role_id;
--> statement-breakpoint
DELETE FROM agent_sessions o USING channel_merge m WHERE o.topic_id = m.old_id;
--> statement-breakpoint
UPDATE tasks SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(tasks.labels) AS e(l) LEFT JOIN channel_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(tasks.labels) AS e(l) JOIN channel_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
UPDATE artifacts SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(artifacts.labels) AS e(l) LEFT JOIN channel_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(artifacts.labels) AS e(l) JOIN channel_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
UPDATE memories SET labels = (
  SELECT jsonb_agg(DISTINCT coalesce('topic:' || m.new_id, e.l))
  FROM jsonb_array_elements_text(memories.labels) AS e(l) LEFT JOIN channel_merge m ON e.l = 'topic:' || m.old_id
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements_text(memories.labels) AS e(l) JOIN channel_merge m ON e.l = 'topic:' || m.old_id);
--> statement-breakpoint
-- One link per channel, for the whole channel.
DELETE FROM external_thread_links l USING channel_merge m WHERE l.topic_id = m.old_id;
--> statement-breakpoint
UPDATE external_thread_links l SET thread_key = '__channel__', meta = '{"kind": "channel"}'::jsonb
FROM channel_topics ct WHERE l.topic_id = ct.new_id AND l.conversation_id = ct.conversation_id;
--> statement-breakpoint
UPDATE topics SET title = '#' || coalesce(c.name, c.external_id)
FROM channel_topics ct JOIN external_conversations c ON c.id = ct.conversation_id
WHERE topics.id = ct.new_id;
--> statement-breakpoint
UPDATE topics SET last_message_at = (SELECT max(created_at) FROM messages WHERE messages.topic_id = topics.id)
WHERE id IN (SELECT new_id FROM channel_topics);
--> statement-breakpoint
DELETE FROM topics USING channel_merge m WHERE topics.id = m.old_id;
--> statement-breakpoint
DROP TABLE channel_merge;
--> statement-breakpoint
DROP TABLE channel_topics;
