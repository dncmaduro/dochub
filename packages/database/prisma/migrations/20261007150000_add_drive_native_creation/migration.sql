CREATE TYPE "DriveNativeDocumentKind" AS ENUM ('DOCUMENT', 'SPREADSHEET', 'PRESENTATION');

CREATE TYPE "DriveCreationOperationStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

ALTER TABLE "DriveConnection"
  ADD COLUMN "authorizedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "DriveCreationOperation" (
  "idempotencyKey" TEXT NOT NULL,
  "userId" UUID NOT NULL,
  "kind" "DriveNativeDocumentKind" NOT NULL,
  "parentId" UUID,
  "locale" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "DriveCreationOperationStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "driveFileId" TEXT,
  "nodeId" UUID,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DriveCreationOperation_pkey" PRIMARY KEY ("idempotencyKey"),
  CONSTRAINT "DriveCreationOperation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DriveCreationOperation_userId_createdAt_idx"
  ON "DriveCreationOperation"("userId", "createdAt");

CREATE INDEX "DriveCreationOperation_status_createdAt_idx"
  ON "DriveCreationOperation"("status", "createdAt");
