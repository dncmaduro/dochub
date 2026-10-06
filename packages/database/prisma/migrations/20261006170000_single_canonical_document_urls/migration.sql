-- General Access already lives on Node. The ShareLink row and token were a
-- second public identity, so remove that identity while keeping each Node ID.
ALTER TABLE "EditorSession"
  DROP CONSTRAINT "EditorSession_actor_identity_check";

ALTER TABLE "EditorSession"
  DROP CONSTRAINT "EditorSession_shareLinkId_fkey";

ALTER TABLE "EditorSession"
  DROP COLUMN "shareLinkId";

ALTER TABLE "EditorSession"
  ADD CONSTRAINT "EditorSession_actor_identity_check"
  CHECK (
    ("actorType" = 'USER' AND "userId" IS NOT NULL)
    OR ("actorType" = 'PUBLIC' AND "userId" IS NULL)
  );

DROP TABLE "ShareLink";
