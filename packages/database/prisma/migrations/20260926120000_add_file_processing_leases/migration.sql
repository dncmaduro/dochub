-- Durable task leases permit SKIP LOCKED claiming, bounded retries, and recovery
-- after a worker dies while a task is PROCESSING.
ALTER TABLE "FileProcessingTask"
  ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- A pre-lease PROCESSING task could have belonged to a crashed legacy worker.
-- Make it immediately reclaimable rather than leaving it permanently stuck.
UPDATE "FileProcessingTask"
SET "leaseExpiresAt" = CURRENT_TIMESTAMP
WHERE "status" = 'PROCESSING';

CREATE INDEX "FileProcessingTask_status_availableAt_idx"
  ON "FileProcessingTask"("status", "availableAt");
