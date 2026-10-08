CREATE TYPE "DriveUploadOperationStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

CREATE TABLE "DriveUploadOperation" (
    "idempotencyKey" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "parentId" UUID,
    "originalFilename" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "sha256" TEXT,
    "status" "DriveUploadOperationStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "driveFileId" TEXT,
    "nodeId" UUID,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveUploadOperation_pkey" PRIMARY KEY ("idempotencyKey"),
    CONSTRAINT "DriveUploadOperation_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DriveUploadOperation_userId_createdAt_idx"
  ON "DriveUploadOperation"("userId", "createdAt");
CREATE INDEX "DriveUploadOperation_status_createdAt_idx"
  ON "DriveUploadOperation"("status", "createdAt");
