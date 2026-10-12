-- The dispatcher now uses System One decision models (provider protocol "systemone"); the "System 1" mark on chat models is gone.
ALTER TABLE "model_configs" DROP COLUMN "system1";