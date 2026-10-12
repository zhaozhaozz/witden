-- A DM is always open: one conversation per person, role and source. Archiving a DM used to leave the pair
-- without an open DM, so opening it again started a second one. Now the most recently active DM of each pair
-- is open and any others stay archived as read-only history.
WITH pairs AS (
  SELECT t.id, t.source, u.participant_id AS user_id, r.participant_id AS role_id, t.last_message_at, t.created_at
  FROM topics t
  JOIN topic_participants u ON u.topic_id = t.id AND u.participant_type = 'user' AND u.removed_at IS NULL
  JOIN topic_participants r ON r.topic_id = t.id AND r.participant_type = 'role' AND r.removed_at IS NULL
  WHERE t.kind = 'dm'
), ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY source, user_id, role_id ORDER BY last_message_at DESC NULLS LAST, created_at
  ) AS rank
  FROM pairs
)
UPDATE topics SET status = CASE WHEN ranked.rank = 1 THEN 'active' ELSE 'archived' END
FROM ranked WHERE topics.id = ranked.id;
--> statement-breakpoint
-- The console labels DMs itself; the stored title is just "person · role".
UPDATE topics SET title = substr(title, 4) WHERE kind = 'dm' AND title LIKE 'DM %';
