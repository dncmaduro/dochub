-- Drive-backed Docs Hub references share the existing File/Node topology but
-- deliberately have no FileVersion or storage object.
CREATE TYPE "FileBackingType" AS ENUM ('LOCAL', 'GOOGLE_DRIVE');
CREATE TYPE "DriveSourceStatus" AS ENUM ('CONNECTED', 'STALE', 'UNAVAILABLE');

ALTER TABLE "File"
  ADD COLUMN "backingType" "FileBackingType" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "driveFileId" UUID;

ALTER TABLE "DriveFile"
  ADD COLUMN "sourceStatus" "DriveSourceStatus" NOT NULL DEFAULT 'CONNECTED';

CREATE UNIQUE INDEX "File_driveFileId_key" ON "File"("driveFileId");
CREATE INDEX "DriveFile_sourceStatus_idx" ON "DriveFile"("sourceStatus");

ALTER TABLE "File"
  ADD CONSTRAINT "File_driveFileId_fkey"
  FOREIGN KEY ("driveFileId") REFERENCES "DriveFile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "File"
  ADD CONSTRAINT "File_drive_backing_consistency_check"
  CHECK (
    ("backingType" = 'LOCAL' AND "driveFileId" IS NULL)
    OR
    ("backingType" = 'GOOGLE_DRIVE' AND "driveFileId" IS NOT NULL AND "currentVersionId" IS NULL AND "versionCounter" = 0)
  );
