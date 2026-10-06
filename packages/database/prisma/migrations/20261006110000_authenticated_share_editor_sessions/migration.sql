ALTER TABLE "EditorSession"
  DROP CONSTRAINT "EditorSession_actor_identity_check";

ALTER TABLE "EditorSession"
  ADD CONSTRAINT "EditorSession_actor_identity_check"
  CHECK (
    ("actorType" = 'USER' AND "userId" IS NOT NULL)
    OR ("actorType" = 'PUBLIC' AND "userId" IS NULL AND "shareLinkId" IS NOT NULL)
  );
