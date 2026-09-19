import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { DocumentCapability } from './document-capability.js';
import { DocumentAuthorizationService } from './document-authorization.service.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase('DocumentAuthorizationService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const memberId = randomUUID();
  const groupId = randomUUID();
  const rootId = randomUUID();
  const inheritedFolderId = randomUUID();
  const inheritedFileId = randomUUID();
  const boundaryFolderId = randomUUID();
  const boundaryFileId = randomUUID();
  const service = new DocumentAuthorizationService({
    prisma,
  } as unknown as DatabaseService);

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `authorization-actor-${suffix}@example.test`,
          normalizedEmail: `authorization-actor-${suffix}@example.test`,
          displayName: 'Authorization actor',
          status: UserStatus.ACTIVE,
        },
        {
          id: memberId,
          email: `authorization-member-${suffix}@example.test`,
          normalizedEmail: `authorization-member-${suffix}@example.test`,
          displayName: 'Authorization member',
          status: UserStatus.ACTIVE,
        },
      ],
    });
    await prisma.group.create({
      data: {
        id: groupId,
        name: `authorization-group-${suffix}`,
        normalizedName: `authorization-group-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.groupMember.create({
      data: { groupId, userId: memberId, addedById: actorId },
    });
    await prisma.node.createMany({
      data: [
        {
          id: rootId,
          type: NodeType.FOLDER,
          name: 'root',
          normalizedName: 'root',
          createdById: actorId,
        },
        {
          id: inheritedFolderId,
          parentId: rootId,
          type: NodeType.FOLDER,
          name: 'inherited',
          normalizedName: 'inherited',
          createdById: actorId,
        },
        {
          id: inheritedFileId,
          parentId: inheritedFolderId,
          type: NodeType.FILE,
          name: 'inherited-file',
          normalizedName: 'inherited-file',
          createdById: actorId,
        },
        {
          id: boundaryFolderId,
          parentId: rootId,
          type: NodeType.FOLDER,
          name: 'boundary',
          normalizedName: 'boundary',
          inheritPermissions: false,
          createdById: actorId,
        },
        {
          id: boundaryFileId,
          parentId: boundaryFolderId,
          type: NodeType.FILE,
          name: 'boundary-file',
          normalizedName: 'boundary-file',
          createdById: actorId,
        },
      ],
    });
    await prisma.permissionEntry.create({
      data: {
        nodeId: rootId,
        groupId,
        role: DocumentRole.EDITOR,
        createdById: actorId,
      },
    });
  });

  afterAll(async () => {
    await prisma.permissionEntry.deleteMany({
      where: {
        nodeId: {
          in: [
            rootId,
            inheritedFolderId,
            inheritedFileId,
            boundaryFolderId,
            boundaryFileId,
          ],
        },
      },
    });
    for (const id of [
      boundaryFileId,
      boundaryFolderId,
      inheritedFileId,
      inheritedFolderId,
      rootId,
    ]) {
      await prisma.node.deleteMany({ where: { id } });
    }
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, memberId] } },
    });
    await prisma.$disconnect();
  });

  it('applies a group ACL through inheritance and stops it at an inheritance boundary', async () => {
    await expect(
      service.hasCapability(
        memberId,
        inheritedFileId,
        DocumentCapability.DELETE,
      ),
    ).resolves.toBe(true);
    await expect(
      service.hasCapability(memberId, boundaryFileId, DocumentCapability.VIEW),
    ).resolves.toBe(false);
  });
});
