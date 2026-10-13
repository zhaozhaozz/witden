-- What a linked thread is on its platform, e.g. a GitHub issue or pull request with its title and address.
ALTER TABLE "external_thread_links" ADD COLUMN "meta" jsonb DEFAULT '{}'::jsonb NOT NULL;