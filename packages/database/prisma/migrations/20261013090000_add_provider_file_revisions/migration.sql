-- Checkpoint 8: provider-backed, provider-neutral content history.
-- Legacy FileVersion and EditorSession remain untouched.

CREATE TYPE "FileRevisionSource" AS ENUM ('INITIAL', 'MANUAL_SAVE', 'RESTORE', 'SAVE_AS_COPY_INITIAL', 'SYSTEM');
CREATE TYPE "FileRevisionProvider" AS ENUM ('LOCAL', 'GOOGLE_DRIVE');
CREATE TYPE "FileSaveOperationStatus" AS ENUM ('PENDING', 'COMPLETED');

ALTER TABLE "File" ADD COLUMN "revisionSequence" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "FileRevision" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "provider" "FileRevisionProvider" NOT NULL,
    "providerVersionId" TEXT NOT NULL,
    "storageRevision" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "checksum" TEXT,
    "source" "FileRevisionSource" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FileSaveOperation" (
    "id" UUID NOT NULL,
    "operationId" TEXT NOT NULL,
    "fileId" UUID NOT NULL,
    "expectedRevision" TEXT NOT NULL,
    "status" "FileSaveOperationStatus" NOT NULL DEFAULT 'PENDING',
    "source" "FileRevisionSource" NOT NULL,
    "resultRevision" TEXT,
    "providerVersionId" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "FileSaveOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FileRevision_fileId_sequence_key" ON "FileRevision"("fileId", "sequence");
CREATE UNIQUE INDEX "FileRevision_fileId_provider_providerVersionId_key" ON "FileRevision"("fileId", "provider", "providerVersionId");
CREATE INDEX "FileRevision_fileId_createdAt_idx" ON "FileRevision"("fileId", "createdAt");
CREATE UNIQUE INDEX "FileSaveOperation_operationId_key" ON "FileSaveOperation"("operationId");
CREATE INDEX "FileSaveOperation_fileId_createdAt_idx" ON "FileSaveOperation"("fileId", "createdAt");
CREATE INDEX "FileSaveOperation_status_createdAt_idx" ON "FileSaveOperation"("status", "createdAt");

ALTER TABLE "FileRevision"
  ADD CONSTRAINT "FileRevision_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FileRevision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FileSaveOperation"
  ADD CONSTRAINT "FileSaveOperation_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FileSaveOperation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
