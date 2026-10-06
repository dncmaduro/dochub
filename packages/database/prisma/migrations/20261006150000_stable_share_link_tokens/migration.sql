-- Existing rows contain one-time random tokens represented only by their hash.
-- Keep them verifiable as v1 until the first explicit Copy performs a single
-- in-place migration to the stable v2 token derived from the existing row ID.
ALTER TABLE "ShareLink"
  ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ShareLink"
  ALTER COLUMN "tokenVersion" SET DEFAULT 2;
