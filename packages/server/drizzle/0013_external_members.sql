-- External members: people from a connected workspace who got an account automatically. They use only the
-- roles their connection allows and never sign in to the console.
ALTER TABLE "users" ADD COLUMN "external_connection_id" text;
--> statement-breakpoint
-- Accounts created that way before (recorded as identity.auto_provision) become external members, unless
-- someone has since given them a console sign-in.
UPDATE users SET external_connection_id = a.connection_id
FROM audit_logs a
WHERE a.action = 'identity.auto_provision' AND a.detail->>'user_id' = users.id
  AND users.password_hash IS NULL AND users.email IS NULL AND NOT users.is_admin;
