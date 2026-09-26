ALTER TABLE "EditorSession"
  ADD COLUMN "stagedArtifactId" UUID,
  ADD COLUMN "stagedSha256" TEXT,
  ADD COLUMN "stagedSizeBytes" BIGINT,
  ADD COLUMN "stagedAt" TIMESTAMP(3);
