-- Search extensions used by future PostgreSQL search queries.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- CreateEnum
CREATE TYPE "FileProcessingTaskType" AS ENUM ('VALIDATION', 'METADATA', 'THUMBNAIL', 'TEXT_EXTRACTION', 'SEARCH_INDEX', 'VIRUS_SCAN');

-- CreateEnum
CREATE TYPE "FileProcessingTaskStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EditorActorType" AS ENUM ('USER', 'PUBLIC');

-- CreateEnum
CREATE TYPE "EditorMode" AS ENUM ('VIEW', 'EDIT');

-- CreateEnum
CREATE TYPE "EditorSessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'FAILED');

-- CreateTable
CREATE TABLE "FileProcessingTask" (
    "id" UUID NOT NULL,
    "fileVersionId" UUID NOT NULL,
    "type" "FileProcessingTaskType" NOT NULL,
    "status" "FileProcessingTaskStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileProcessingTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SearchDocument" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "fileVersionId" UUID NOT NULL,
    "contentText" TEXT NOT NULL,
    "searchVector" tsvector,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EditorSession" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "baseVersionId" UUID NOT NULL,
    "documentKey" TEXT NOT NULL,
    "actorType" "EditorActorType" NOT NULL,
    "userId" UUID,
    "shareLinkId" UUID,
    "mode" "EditorMode" NOT NULL,
    "status" "EditorSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "EditorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Favorite" (
    "userId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Favorite_pkey" PRIMARY KEY ("userId","nodeId")
);

-- CreateTable
CREATE TABLE "RecentItem" (
    "userId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "lastAccessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentItem_pkey" PRIMARY KEY ("userId","nodeId")
);

-- CreateIndex
CREATE INDEX "FileProcessingTask_status_createdAt_idx" ON "FileProcessingTask"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FileProcessingTask_fileVersionId_type_key" ON "FileProcessingTask"("fileVersionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SearchDocument_fileId_key" ON "SearchDocument"("fileId");

-- CreateIndex
CREATE INDEX "SearchDocument_fileVersionId_idx" ON "SearchDocument"("fileVersionId");

-- Search vectors are populated explicitly by the future indexing worker.
CREATE INDEX "SearchDocument_searchVector_gin_idx" ON "SearchDocument" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "EditorSession_documentKey_idx" ON "EditorSession"("documentKey");

-- CreateIndex
CREATE INDEX "RecentItem_userId_lastAccessedAt_idx" ON "RecentItem"("userId", "lastAccessedAt");

-- Editor sessions must have exactly one actor matching their actor type.
ALTER TABLE "EditorSession" ADD CONSTRAINT "EditorSession_actor_identity_check"
CHECK (
    ("actorType" = 'USER' AND "userId" IS NOT NULL AND "shareLinkId" IS NULL)
    OR ("actorType" = 'PUBLIC' AND "userId" IS NULL AND "shareLinkId" IS NOT NULL)
);

-- AddForeignKey
ALTER TABLE "FileProcessingTask" ADD CONSTRAINT "FileProcessingTask_fileVersionId_fkey" FOREIGN KEY ("fileVersionId") REFERENCES "FileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_fileVersionId_fkey" FOREIGN KEY ("fileVersionId") REFERENCES "FileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorSession" ADD CONSTRAINT "EditorSession_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorSession" ADD CONSTRAINT "EditorSession_fileId_baseVersionId_fkey" FOREIGN KEY ("fileId", "baseVersionId") REFERENCES "FileVersion"("fileId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorSession" ADD CONSTRAINT "EditorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditorSession" ADD CONSTRAINT "EditorSession_shareLinkId_fkey" FOREIGN KEY ("shareLinkId") REFERENCES "ShareLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Favorite" ADD CONSTRAINT "Favorite_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentItem" ADD CONSTRAINT "RecentItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentItem" ADD CONSTRAINT "RecentItem_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;
