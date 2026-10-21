-- A role's contact list now names the roles it may start a direct conversation with. Earlier entries meant
-- something else (whom it could hand work to), so every list starts empty: a person grants each contact again.
UPDATE "roles" SET "allowed_contacts" = '[]'::jsonb WHERE "allowed_contacts" <> '[]'::jsonb;
