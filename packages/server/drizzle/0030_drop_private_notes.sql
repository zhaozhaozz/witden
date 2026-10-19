-- A person's private notes (memories.scope = 'user') are gone: a role keeps notes for one topic or DM, or as
-- itself (role memory). Existing ones are deleted. Tasks and conversations that read them keep their user:
-- labels, since their context may still hold what was read.
DELETE FROM memories WHERE scope = 'user';
