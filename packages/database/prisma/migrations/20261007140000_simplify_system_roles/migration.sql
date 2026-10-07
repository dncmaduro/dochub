-- Replace the legacy ADMIN/MEMBER account role enum in one transaction.
-- Existing MEMBER accounts retain their management access as DOCUMENT_MANAGER.
CREATE TYPE "SystemRole_new" AS ENUM ('ADMIN', 'DOCUMENT_MANAGER', 'VIEWER');

ALTER TABLE "User"
  ALTER COLUMN "systemRole" DROP DEFAULT;

ALTER TABLE "User"
  ALTER COLUMN "systemRole" TYPE "SystemRole_new"
  USING (
    CASE "systemRole"::text
      WHEN 'MEMBER' THEN 'DOCUMENT_MANAGER'::"SystemRole_new"
      ELSE "systemRole"::text::"SystemRole_new"
    END
  );

DROP TYPE "SystemRole";
ALTER TYPE "SystemRole_new" RENAME TO "SystemRole";

ALTER TABLE "User"
  ALTER COLUMN "systemRole" SET DEFAULT 'VIEWER'::"SystemRole";
