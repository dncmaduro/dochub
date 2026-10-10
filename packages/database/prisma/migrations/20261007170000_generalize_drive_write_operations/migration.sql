ALTER TYPE "DriveNativeDocumentKind" RENAME TO "DriveWriteOperationKind";
ALTER TYPE "DriveWriteOperationKind" ADD VALUE 'BINARY_UPLOAD';
ALTER TYPE "DriveCreationOperationStatus" RENAME TO "DriveWriteOperationStatus";

ALTER TABLE "DriveCreationOperation" RENAME TO "DriveWriteOperation";
ALTER TABLE "DriveWriteOperation" ALTER COLUMN "locale" DROP NOT NULL;
ALTER TABLE "DriveWriteOperation"
  ADD COLUMN "mimeType" TEXT,
  ADD COLUMN "sizeBytes" BIGINT,
  ADD COLUMN "sha256" TEXT;

ALTER INDEX "DriveCreationOperation_userId_createdAt_idx"
  RENAME TO "DriveWriteOperation_userId_createdAt_idx";
ALTER INDEX "DriveCreationOperation_status_createdAt_idx"
  RENAME TO "DriveWriteOperation_status_createdAt_idx";
ALTER TABLE "DriveWriteOperation"
  RENAME CONSTRAINT "DriveCreationOperation_pkey" TO "DriveWriteOperation_pkey";
ALTER TABLE "DriveWriteOperation"
  RENAME CONSTRAINT "DriveCreationOperation_userId_fkey" TO "DriveWriteOperation_userId_fkey";
