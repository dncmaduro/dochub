-- FileVersion attribution is immutable first-class metadata. The audit-log
-- lookup is only used for this historical migration; runtime reads use the
-- FileVersion columns directly.
ALTER TYPE "AuditActorType" ADD VALUE IF NOT EXISTS 'COLLABORATIVE';

CREATE TYPE "FileVersionActorType" AS ENUM ('USER', 'PUBLIC', 'SYSTEM', 'COLLABORATIVE');

ALTER TABLE "FileVersion"
ADD COLUMN "actorType" "FileVersionActorType";

UPDATE "FileVersion" AS version
SET "actorType" = CASE
  WHEN version."createdById" IS NOT NULL THEN 'USER'::"FileVersionActorType"
  WHEN version."source" = 'EDITOR'::"FileVersionSource"
    AND EXISTS (
      SELECT 1
      FROM "AuditLog" AS audit
      WHERE audit."resourceId" = version."id"
        AND audit."resourceType" = 'FILE_VERSION'
        AND audit."action" = 'FILE_VERSION_CREATED'
        AND audit."actorType" = 'PUBLIC'::"AuditActorType"
    ) THEN 'PUBLIC'::"FileVersionActorType"
  ELSE 'SYSTEM'::"FileVersionActorType"
END;

ALTER TABLE "FileVersion"
ALTER COLUMN "actorType" SET DEFAULT 'SYSTEM',
ALTER COLUMN "actorType" SET NOT NULL;
