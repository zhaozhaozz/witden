ALTER TABLE "computer_instances" ADD COLUMN "software" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "computer_instances" ADD COLUMN "software_status" jsonb;--> statement-breakpoint
ALTER TABLE "computer_templates" DROP COLUMN "sudo_apt";--> statement-breakpoint
-- A template's software list described its image; it now lists packages the platform installs, so the old
-- descriptions (the image already has those tools) must not be installed.
UPDATE "computer_templates" SET "software" = '[]'::jsonb;--> statement-breakpoint
UPDATE "computer_templates" SET "description" = 'Development computer: Debian with git, Python (pip, venv), Node.js (npm), build tools, ripgrep and tmux. The runner and every AI action run as the unprivileged user ''witden''. System packages are installed by the platform: roles ask for them, and the software list is installed whenever the computer starts. Other tools go under ~/.local.'
WHERE "name" = 'dev-shell' AND "description" = 'Development computer: Debian with git, Python, Node.js, build tools and tmux. The runner and every AI action run as the unprivileged user ''witden''; install tools user-locally or bake them into a template.';--> statement-breakpoint
UPDATE "computer_templates" SET "description" = 'Linux desktop (Xvfb + Fluxbox) with Chromium and the same development tools as dev-shell. AI actions and people watching over noVNC use the same desktop; background browser sessions are shown separately. System packages are installed by the platform.'
WHERE "name" = 'desktop-browser' AND "description" = 'Linux desktop (Xvfb + Fluxbox) with Chromium. AI actions and people watching over noVNC use the same desktop; background browser sessions are shown separately.';--> statement-breakpoint
-- Roles that work in a computer may have system packages installed and keep its software list.
UPDATE "roles" SET "allowed_tools" = "allowed_tools" || '["system_software", "software_list"]'::jsonb
WHERE "allowed_tools" ? 'shell' AND NOT "allowed_tools" ? 'system_software';
