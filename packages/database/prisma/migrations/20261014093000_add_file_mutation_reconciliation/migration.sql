-- CP8.1: additive, durable reconciliation metadata for provider mutations.
-- Existing completed save operations retain their historical semantics.

CREATE TYPE "FileSaveOperationType" AS ENUM ('SAVE', 'RESTORE');

ALTER TYPE "FileSaveOperationStatus" ADD VALUE IF NOT EXISTS 'PROVIDER_WRITTEN';
ALTER TYPE "FileSaveOperationStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "FileSaveOperation"
  ADD COLUMN "operationType" "FileSaveOperationType" NOT NULL DEFAULT 'SAVE',
  ADD COLUMN "sourceRevisionId" UUID,
  ADD COLUMN "previousStorageRevision" TEXT,
  ADD COLUMN "previousProviderVersionId" TEXT,
  ADD COLUMN "previousSizeBytes" BIGINT,
  ADD COLUMN "previousChecksum" TEXT,
  ADD COLUMN "resultSizeBytes" BIGINT,
  ADD COLUMN "resultChecksum" TEXT,
  ADD COLUMN "providerWrittenAt" TIMESTAMP(3),
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "finalizationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastFinalizationError" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "FileRevision" ADD COLUMN "operationId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "mutationOperationId" TEXT;
ALTER TABLE "OutboxEvent" ADD COLUMN "mutationOperationId" TEXT;

DROP INDEX "FileSaveOperation_status_createdAt_idx";
CREATE INDEX "FileSaveOperation_status_updatedAt_idx" ON "FileSaveOperation"("status", "updatedAt");
CREATE UNIQUE INDEX "FileRevision_operationId_key" ON "FileRevision"("operationId");
CREATE UNIQUE INDEX "AuditLog_mutationOperationId_key" ON "AuditLog"("mutationOperationId");
CREATE UNIQUE INDEX "OutboxEvent_mutationOperationId_key" ON "OutboxEvent"("mutationOperationId");
