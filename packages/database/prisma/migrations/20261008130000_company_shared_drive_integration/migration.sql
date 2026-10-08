-- Move Google Drive ownership from individual users to the single company
-- integration. Legacy DriveConnection rows and their encrypted credentials
-- are intentionally retained for audit/recovery until the new integration has
-- been verified by an administrator.

CREATE TABLE "GoogleDriveIntegration" (
    "id" UUID NOT NULL,
    "singletonKey" TEXT NOT NULL DEFAULT 'company',
    "sharedDriveId" TEXT,
    "sharedDriveName" TEXT,
    "storageFolderId" TEXT,
    "storageFolderName" TEXT,
    "googleAccountId" TEXT,
    "googleEmail" TEXT,
    "accessTokenEncrypted" TEXT,
    "refreshTokenEncrypted" TEXT,
    "connectedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "syncStatus" "DriveSyncStatus" NOT NULL DEFAULT 'NEVER_SYNCED',
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncCompletedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "revokedAt" TIMESTAMP(3),
    "authorizedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "GoogleDriveIntegration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoogleDriveIntegration_singletonKey_key"
  ON "GoogleDriveIntegration"("singletonKey");
CREATE INDEX "GoogleDriveIntegration_revokedAt_idx"
  ON "GoogleDriveIntegration"("revokedAt");
CREATE INDEX "GoogleDriveIntegration_syncStatus_idx"
  ON "GoogleDriveIntegration"("syncStatus");

INSERT INTO "GoogleDriveIntegration" ("id", "singletonKey")
VALUES ('00000000-0000-4000-8000-000000000001', 'company')
ON CONFLICT ("singletonKey") DO NOTHING;

-- Preserve the existing encrypted credential material by copying the first
-- connected legacy row into the company integration. The legacy rows remain
-- untouched, and an administrator can reconnect/select the Shared Drive when
-- the copied account is not the intended company administrator.
WITH "legacy" AS (
  SELECT "googleAccountId", "googleEmail", "accessTokenEncrypted",
         "refreshTokenEncrypted", "connectedAt", "updatedAt",
         "accessTokenExpiresAt", "syncStatus", "lastSyncStartedAt",
         "lastSyncCompletedAt", "lastSyncError", "revokedAt",
         "authorizedScopes"
  FROM "DriveConnection"
  ORDER BY ("revokedAt" IS NULL) DESC, "connectedAt" ASC, "id" ASC
  LIMIT 1
)
UPDATE "GoogleDriveIntegration" AS "integration"
SET "googleAccountId" = "legacy"."googleAccountId",
    "googleEmail" = "legacy"."googleEmail",
    "accessTokenEncrypted" = "legacy"."accessTokenEncrypted",
    "refreshTokenEncrypted" = "legacy"."refreshTokenEncrypted",
    "connectedAt" = "legacy"."connectedAt",
    "updatedAt" = "legacy"."updatedAt",
    "accessTokenExpiresAt" = "legacy"."accessTokenExpiresAt",
    "syncStatus" = "legacy"."syncStatus",
    "lastSyncStartedAt" = "legacy"."lastSyncStartedAt",
    "lastSyncCompletedAt" = "legacy"."lastSyncCompletedAt",
    "lastSyncError" = "legacy"."lastSyncError",
    "revokedAt" = "legacy"."revokedAt",
    "authorizedScopes" = "legacy"."authorizedScopes"
FROM "legacy"
WHERE "integration"."singletonKey" = 'company';

ALTER TABLE "DriveFile" ADD COLUMN "driveIntegrationId" UUID;
UPDATE "DriveFile" AS "file"
SET "driveIntegrationId" = "integration"."id"
FROM "GoogleDriveIntegration" AS "integration"
WHERE "integration"."singletonKey" = 'company';
ALTER TABLE "DriveFile" ALTER COLUMN "driveIntegrationId" SET NOT NULL;

-- A Drive file ID is the external identity of a file in this company corpus.
-- Refuse to silently discard conflicting metadata if an old per-user sync has
-- produced duplicate rows; this is a recoverable migration error for manual
-- reconciliation, not an implicit data deletion.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DriveFile"
    GROUP BY "driveFileId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'DriveFile contains duplicate driveFileId values; reconcile metadata before applying company integration migration';
  END IF;
END $$;

ALTER TABLE "DriveFile" DROP CONSTRAINT "DriveFile_driveConnectionId_fkey";
DROP INDEX "DriveFile_driveConnectionId_driveFileId_key";
DROP INDEX "DriveFile_driveConnectionId_driveModifiedTime_idx";
DROP INDEX "DriveFile_driveConnectionId_normalizedType_idx";
ALTER TABLE "DriveFile" DROP COLUMN "driveConnectionId";
ALTER TABLE "DriveFile"
  ADD CONSTRAINT "DriveFile_driveIntegrationId_fkey"
  FOREIGN KEY ("driveIntegrationId") REFERENCES "GoogleDriveIntegration"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "DriveFile_driveFileId_key" ON "DriveFile"("driveFileId");
CREATE INDEX "DriveFile_driveIntegrationId_driveModifiedTime_idx"
  ON "DriveFile"("driveIntegrationId", "driveModifiedTime");
CREATE INDEX "DriveFile_driveIntegrationId_normalizedType_idx"
  ON "DriveFile"("driveIntegrationId", "normalizedType");

ALTER TABLE "DriveFileMigration" ADD COLUMN "driveIntegrationId" UUID;
UPDATE "DriveFileMigration" AS "migration"
SET "driveIntegrationId" = "integration"."id"
FROM "GoogleDriveIntegration" AS "integration"
WHERE "integration"."singletonKey" = 'company'
  AND "migration"."driveConnectionId" IS NOT NULL;
ALTER TABLE "DriveFileMigration" DROP CONSTRAINT "DriveFileMigration_driveConnectionId_fkey";
ALTER TABLE "DriveFileMigration" DROP COLUMN "driveConnectionId";
ALTER TABLE "DriveFileMigration"
  ADD CONSTRAINT "DriveFileMigration_driveIntegrationId_fkey"
  FOREIGN KEY ("driveIntegrationId") REFERENCES "GoogleDriveIntegration"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
