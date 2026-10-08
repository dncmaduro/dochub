CREATE TYPE "DriveFileMigrationStatus" AS ENUM (
  'PENDING', 'UPLOADING', 'UPLOADED', 'VERIFYING', 'VERIFIED',
  'COMPLETED', 'FAILED', 'BLOCKED', 'STALE', 'ROLLED_BACK'
);

CREATE TABLE "DriveFileMigration" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "sourceVersionId" UUID NOT NULL,
    "status" "DriveFileMigrationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "driveConnectionId" UUID,
    "driveFileRecordId" UUID,
    "remoteDriveFileId" TEXT,
    "sourceSha256" TEXT NOT NULL,
    "sourceSizeBytes" BIGINT NOT NULL,
    "remoteName" TEXT,
    "remoteMimeType" TEXT,
    "remoteSizeBytes" BIGINT,
    "remoteMd5Checksum" TEXT,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "uploadedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveFileMigration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DriveFileMigration_fileId_fkey"
      FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DriveFileMigration_sourceVersionId_fkey"
      FOREIGN KEY ("sourceVersionId") REFERENCES "FileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DriveFileMigration_driveConnectionId_fkey"
      FOREIGN KEY ("driveConnectionId") REFERENCES "DriveConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DriveFileMigration_driveFileRecordId_fkey"
      FOREIGN KEY ("driveFileRecordId") REFERENCES "DriveFile"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DriveFileMigration_fileId_sourceVersionId_key"
  ON "DriveFileMigration"("fileId", "sourceVersionId");
CREATE INDEX "DriveFileMigration_status_createdAt_idx"
  ON "DriveFileMigration"("status", "createdAt");
CREATE INDEX "DriveFileMigration_fileId_createdAt_idx"
  ON "DriveFileMigration"("fileId", "createdAt");
CREATE INDEX "DriveFileMigration_leaseExpiresAt_idx"
  ON "DriveFileMigration"("leaseExpiresAt");
