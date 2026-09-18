-- CreateEnum
CREATE TYPE "FileVersionSource" AS ENUM ('UPLOAD', 'EDITOR', 'RESTORE', 'SYSTEM');

-- CreateTable
CREATE TABLE "File" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "currentVersionId" UUID,
    "versionCounter" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "File_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileVersion" (
    "id" UUID NOT NULL,
    "fileId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "source" "FileVersionSource" NOT NULL,
    "sourceVersionId" UUID,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "File_nodeId_key" ON "File"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "File_id_currentVersionId_key" ON "File"("id", "currentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_storageKey_key" ON "FileVersion"("storageKey");

-- CreateIndex
CREATE INDEX "FileVersion_fileId_idx" ON "FileVersion"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_fileId_versionNumber_key" ON "FileVersion"("fileId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FileVersion_fileId_id_key" ON "FileVersion"("fileId", "id");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_id_currentVersionId_fkey" FOREIGN KEY ("id", "currentVersionId") REFERENCES "FileVersion"("fileId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "FileVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileVersion" ADD CONSTRAINT "FileVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
