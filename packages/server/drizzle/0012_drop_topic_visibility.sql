-- Topics have no visibility setting any more: a topic or DM is read by its participants only (team-wide
-- "internal" topics now behave like the private ones).
ALTER TABLE "topics" DROP COLUMN "visibility";