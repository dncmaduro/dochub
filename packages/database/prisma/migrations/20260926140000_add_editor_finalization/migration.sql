ALTER TABLE "EditorSession"
  ADD COLUMN "finalizedFileVersionId" UUID,
  ADD COLUMN "finalizedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "EditorSession_finalizedFileVersionId_key"
  ON "EditorSession"("finalizedFileVersionId");

ALTER TABLE "EditorSession"
  ADD CONSTRAINT "EditorSession_finalizedFileVersionId_fkey"
  FOREIGN KEY ("finalizedFileVersionId") REFERENCES "FileVersion"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
