CREATE TYPE "GeneralAccessRole" AS ENUM ('RESTRICTED', 'VIEWER', 'EDITOR');

ALTER TABLE "Node"
  ALTER COLUMN "publicAccess" DROP DEFAULT,
  ALTER COLUMN "publicAccess" TYPE "GeneralAccessRole"
    USING CASE
      WHEN "publicAccess" THEN 'VIEWER'::"GeneralAccessRole"
      ELSE 'RESTRICTED'::"GeneralAccessRole"
    END;

ALTER TABLE "Node"
  RENAME COLUMN "publicAccess" TO "generalAccessRole";

ALTER TABLE "Node"
  ALTER COLUMN "generalAccessRole" SET DEFAULT 'RESTRICTED';
