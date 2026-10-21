-- Work has no step limit any more: runs are bounded by token limits, emergency stops and cancellation.
ALTER TABLE "roles" DROP COLUMN "max_steps";
