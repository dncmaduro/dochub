-- New Nodes are viewable through the existing General Access policy by
-- default. Existing restricted content is promoted to the new default;
-- already-viewable and editor content are left unchanged.
ALTER TABLE "Node"
  ALTER COLUMN "generalAccessRole" SET DEFAULT 'VIEWER';

UPDATE "Node"
SET "generalAccessRole" = 'VIEWER'
WHERE "generalAccessRole" = 'RESTRICTED';
