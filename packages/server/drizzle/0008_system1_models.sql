-- Models can be marked as fast ("System 1"); only those may serve as the dispatcher of auto topics.
ALTER TABLE "model_configs" ADD COLUMN "system1" boolean DEFAULT false NOT NULL;