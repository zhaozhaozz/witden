-- Reading other topics is a permission of the role now (the "topics" tool group, off for new roles), and what
-- read_topic returns is no longer tracked as a source. Labels of other topics, which only read_topic put on
-- conversations, tasks and the topic notes written after it, are dropped; a row keeps its own topic's label and
-- every other kind (private notes, knowledge spaces, Feishu).
UPDATE agent_sessions s SET labels = coalesce((
  SELECT jsonb_agg(l) FROM jsonb_array_elements_text(s.labels) AS l
  WHERE l NOT LIKE 'topic:%' OR l = 'topic:' || s.topic_id
), '[]'::jsonb);
--> statement-breakpoint
UPDATE tasks t SET labels = coalesce((
  SELECT jsonb_agg(l) FROM jsonb_array_elements_text(t.labels) AS l
  WHERE l NOT LIKE 'topic:%' OR l = 'topic:' || t.topic_id
), '[]'::jsonb);
--> statement-breakpoint
UPDATE memories m SET labels = coalesce((
  SELECT jsonb_agg(l) FROM jsonb_array_elements_text(m.labels) AS l
  WHERE l NOT LIKE 'topic:%' OR l = 'topic:' || m.topic_id
), '[]'::jsonb)
WHERE m.scope = 'topic' AND m.topic_id IS NOT NULL;
