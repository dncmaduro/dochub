-- A document key identifies the shared ONLYOFFICE generation, not an
-- individual EditorSession. Multiple sessions may therefore finalize to the
-- same immutable FileVersion.
DROP INDEX IF EXISTS "EditorSession_finalizedFileVersionId_key";

CREATE INDEX "EditorSession_fileId_baseVersionId_documentKey_mode_status_idx"
  ON "EditorSession"("fileId", "baseVersionId", "documentKey", "mode", "status");
