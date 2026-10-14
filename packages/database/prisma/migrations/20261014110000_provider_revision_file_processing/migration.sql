-- CP9: provider-backed derived processing. This migration is deliberately
-- additive so pre-CP8 local FileVersion rows remain inspectable while new
-- tasks use Docs Hub file identity plus the opaque authoritative revision.

ALTER TABLE "FileProcessingTask"
  ALTER COLUMN "fileVersionId" DROP NOT NULL,
  ADD COLUMN "fileId" UUID,
  ADD COLUMN "targetRevision" TEXT;

ALTER TABLE "FileProcessingTask"
  ADD CONSTRAINT "FileProcessingTask_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "FileProcessingTask_fileId_targetRevision_type_key"
  ON "FileProcessingTask"("fileId", "targetRevision", "type");
CREATE INDEX "FileProcessingTask_fileId_targetRevision_idx"
  ON "FileProcessingTask"("fileId", "targetRevision");

ALTER TABLE "SearchDocument"
  ALTER COLUMN "fileVersionId" DROP NOT NULL,
  ADD COLUMN "indexedRevision" TEXT;
CREATE INDEX "SearchDocument_indexedRevision_idx"
  ON "SearchDocument"("indexedRevision");
-- The pre-CP9 normalization migration removed this index while the content
-- projection was dormant. CP9 makes SearchDocument a hot query path again.
CREATE INDEX "SearchDocument_searchVector_gin_idx"
  ON "SearchDocument" USING GIN ("searchVector");

CREATE TABLE "FileTextExtraction" (
  "id" UUID NOT NULL,
  "fileId" UUID NOT NULL,
  "targetRevision" TEXT NOT NULL,
  "contentText" TEXT NOT NULL,
  "truncated" BOOLEAN NOT NULL DEFAULT false,
  "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileTextExtraction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FileTextExtraction_fileId_targetRevision_key"
  ON "FileTextExtraction"("fileId", "targetRevision");
CREATE INDEX "FileTextExtraction_fileId_updatedAt_idx"
  ON "FileTextExtraction"("fileId", "updatedAt");

ALTER TABLE "FileTextExtraction"
  ADD CONSTRAINT "FileTextExtraction_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;
