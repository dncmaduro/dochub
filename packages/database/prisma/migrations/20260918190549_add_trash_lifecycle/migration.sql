-- CreateEnum
CREATE TYPE "TrashOperationStatus" AS ENUM ('ACTIVE', 'RESTORED', 'PURGING', 'PURGED');

-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "trashOperationId" UUID;

-- CreateTable
CREATE TABLE "TrashOperation" (
    "id" UUID NOT NULL,
    "rootNodeId" UUID,
    "originalParentId" UUID,
    "trashedById" UUID,
    "status" "TrashOperationStatus" NOT NULL DEFAULT 'ACTIVE',
    "trashedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "restoredAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "TrashOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrashOperation_status_expiresAt_idx" ON "TrashOperation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Node_trashOperationId_idx" ON "Node"("trashOperationId");

-- Active non-root siblings must have distinct normalized names.
CREATE UNIQUE INDEX "Node_active_child_parentId_normalizedName_key" ON "Node"("parentId", "normalizedName")
WHERE "trashOperationId" IS NULL AND "parentId" IS NOT NULL;

-- Active root nodes must have distinct normalized names.
CREATE UNIQUE INDEX "Node_active_root_normalizedName_key" ON "Node"("normalizedName")
WHERE "trashOperationId" IS NULL AND "parentId" IS NULL;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_trashOperationId_fkey" FOREIGN KEY ("trashOperationId") REFERENCES "TrashOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrashOperation" ADD CONSTRAINT "TrashOperation_rootNodeId_fkey" FOREIGN KEY ("rootNodeId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrashOperation" ADD CONSTRAINT "TrashOperation_originalParentId_fkey" FOREIGN KEY ("originalParentId") REFERENCES "Node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrashOperation" ADD CONSTRAINT "TrashOperation_trashedById_fkey" FOREIGN KEY ("trashedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
