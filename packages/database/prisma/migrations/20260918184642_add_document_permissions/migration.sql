-- CreateEnum
CREATE TYPE "DocumentRole" AS ENUM ('VIEWER', 'EDITOR', 'OWNER');

-- CreateTable
CREATE TABLE "PermissionEntry" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "userId" UUID,
    "groupId" UUID,
    "role" "DocumentRole" NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PermissionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PermissionEntry_userId_idx" ON "PermissionEntry"("userId");

-- CreateIndex
CREATE INDEX "PermissionEntry_groupId_idx" ON "PermissionEntry"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionEntry_nodeId_userId_key" ON "PermissionEntry"("nodeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionEntry_nodeId_groupId_key" ON "PermissionEntry"("nodeId", "groupId");

-- Enforce that each ACL entry addresses exactly one principal.
ALTER TABLE "PermissionEntry" ADD CONSTRAINT "PermissionEntry_exactly_one_principal_check"
CHECK (
    ("userId" IS NOT NULL AND "groupId" IS NULL)
    OR ("userId" IS NULL AND "groupId" IS NOT NULL)
);

-- AddForeignKey
ALTER TABLE "PermissionEntry" ADD CONSTRAINT "PermissionEntry_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionEntry" ADD CONSTRAINT "PermissionEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionEntry" ADD CONSTRAINT "PermissionEntry_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionEntry" ADD CONSTRAINT "PermissionEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
