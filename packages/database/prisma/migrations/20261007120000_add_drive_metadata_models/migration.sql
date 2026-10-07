-- Google Drive metadata-only integration. No local file/blob relation is intentional.
CREATE TYPE "DriveSyncStatus" AS ENUM ('NEVER_SYNCED', 'SYNCING', 'SYNCED', 'FAILED');
CREATE TYPE "DriveFileType" AS ENUM ('FOLDER', 'GOOGLE_DOC', 'GOOGLE_SHEET', 'GOOGLE_SLIDE', 'PDF', 'IMAGE', 'VIDEO', 'DOCX', 'XLSX', 'PPTX', 'BINARY');
CREATE TYPE "DriveFileLocation" AS ENUM ('MY_DRIVE', 'SHARED_WITH_ME', 'SHARED_DRIVE', 'UNKNOWN');

CREATE TABLE "DriveConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "googleAccountId" TEXT,
    "googleEmail" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "syncStatus" "DriveSyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DriveConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DriveFile" (
    "id" UUID NOT NULL,
    "driveConnectionId" UUID NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "normalizedType" "DriveFileType" NOT NULL,
    "webViewLink" TEXT,
    "driveModifiedTime" TIMESTAMP(3),
    "driveCreatedTime" TIMESTAMP(3),
    "trashed" BOOLEAN NOT NULL DEFAULT false,
    "driveParents" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "location" "DriveFileLocation" NOT NULL DEFAULT 'UNKNOWN',
    "sharedDriveId" TEXT,
    "sizeBytes" BIGINT,
    "driveVersion" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriveFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DriveConnection_userId_key" ON "DriveConnection"("userId");
CREATE INDEX "DriveConnection_revokedAt_idx" ON "DriveConnection"("revokedAt");
CREATE INDEX "DriveConnection_syncStatus_idx" ON "DriveConnection"("syncStatus");
CREATE UNIQUE INDEX "DriveFile_driveConnectionId_driveFileId_key" ON "DriveFile"("driveConnectionId", "driveFileId");
CREATE INDEX "DriveFile_driveConnectionId_driveModifiedTime_idx" ON "DriveFile"("driveConnectionId", "driveModifiedTime");
CREATE INDEX "DriveFile_driveConnectionId_normalizedType_idx" ON "DriveFile"("driveConnectionId", "normalizedType");

ALTER TABLE "DriveConnection" ADD CONSTRAINT "DriveConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DriveFile" ADD CONSTRAINT "DriveFile_driveConnectionId_fkey" FOREIGN KEY ("driveConnectionId") REFERENCES "DriveConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
