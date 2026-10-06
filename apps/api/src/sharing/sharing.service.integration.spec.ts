import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import {
  DocumentRole,
  GeneralAccessRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { UpdateSharingDto } from './dto/update-sharing.dto.js';
import { SharingService } from './sharing.service.js';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;

describeWithDatabase('SharingService integration', () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const invisibleId = randomUUID();
  const adminId = randomUUID();
  const suspendedId = randomUUID();
  const groupId = randomUUID();
  const nodeIds = new Set<string>();
  const operationIds = new Set<string>();
  const database = { prisma } as unknown as DatabaseService;
  const sharing = new SharingService(database, new DocumentAuthorizationService(database), {
    webOrigins: ['https://dochub.example.test'],
  } as never);
  let nodeId: string;
  let trashedNodeId: string;
  let parentId: string;

  async function node(name: string, parent: string | null = null): Promise<string> {
    const record = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        parentId: parent,
        name: `${name}-${suffix}`,
        normalizedName: `${name}-${suffix}`,
        createdById: ownerId,
      },
    });
    nodeIds.add(record.id);
    await prisma.permissionEntry.create({
      data: { nodeId: record.id, userId: ownerId, role: DocumentRole.OWNER },
    });
    return record.id;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: ownerId, email: `sharing-owner-${suffix}@example.test`, normalizedEmail: `sharing-owner-${suffix}@example.test`, displayName: 'Sharing owner', status: UserStatus.ACTIVE },
        { id: viewerId, email: `sharing-viewer-${suffix}@example.test`, normalizedEmail: `sharing-viewer-${suffix}@example.test`, displayName: 'Sharing viewer', status: UserStatus.ACTIVE },
        { id: invisibleId, email: `sharing-invisible-${suffix}@example.test`, normalizedEmail: `sharing-invisible-${suffix}@example.test`, displayName: 'Sharing invisible', status: UserStatus.ACTIVE },
        { id: adminId, email: `sharing-admin-${suffix}@example.test`, normalizedEmail: `sharing-admin-${suffix}@example.test`, displayName: 'Sharing administrator', status: UserStatus.ACTIVE, systemRole: SystemRole.ADMIN },
        { id: suspendedId, email: `sharing-suspended-${suffix}@example.test`, normalizedEmail: `sharing-suspended-${suffix}@example.test`, displayName: 'Suspended directory user', status: UserStatus.SUSPENDED },
      ],
    });
    await prisma.group.create({
      data: { id: groupId, name: `Directory group ${suffix}`, normalizedName: `directory group ${suffix}`, createdById: ownerId },
    });
    nodeId = await node('sharing-node');
    trashedNodeId = await node('sharing-trashed');
    parentId = await node('sharing-parent');
    await prisma.permissionEntry.create({
      data: { nodeId, userId: viewerId, role: DocumentRole.VIEWER },
    });
    const operation = await prisma.trashOperation.create({
      data: { rootNodeId: trashedNodeId, trashedById: ownerId, expiresAt: new Date(Date.now() + 86_400_000) },
    });
    operationIds.add(operation.id);
    await prisma.node.update({ where: { id: trashedNodeId }, data: { trashOperationId: operation.id } });
  });

  afterAll(async () => {
    const ids = [...nodeIds];
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    if (nodeId)
      await prisma.node.updateMany({ where: { id: nodeId }, data: { parentId: null } });
    await prisma.node.updateMany({ where: { id: { in: ids } }, data: { trashOperationId: null } });
    await prisma.trashOperation.deleteMany({ where: { id: { in: [...operationIds] } } });
    await prisma.node.deleteMany({ where: { id: { in: ids } } });
    await prisma.group.deleteMany({ where: { id: groupId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, viewerId, invisibleId, adminId, suspendedId] } } });
    await prisma.$disconnect();
  });

  it('finds active directory principals without granting document access', async () => {
    const principals = await sharing.findPrincipals(ownerId, `directory group ${suffix}`);
    expect(principals.items).toEqual([{ type: 'GROUP', id: groupId, name: `Directory group ${suffix}` }]);
    const users = await sharing.findPrincipals(ownerId, 'sharing owner');
    expect(users.items).toContainEqual({
      type: 'USER', id: ownerId, displayName: 'Sharing owner', email: `sharing-owner-${suffix}@example.test`,
    });
    expect(JSON.stringify([...principals.items, ...users.items])).not.toContain('systemRole');
    expect(JSON.stringify(principals.items)).not.toContain('description');
  });

  it('reports sharing state and enforces VIEW and SHARE authorization', async () => {
    await expect(sharing.getState(invisibleId, nodeId)).rejects.toMatchObject({ status: 404 });
    await expect(sharing.getState(adminId, nodeId)).rejects.toMatchObject({ status: 404 });
    await expect(sharing.getState(suspendedId, nodeId)).rejects.toMatchObject({ status: 404 });
    await expect(sharing.getState(viewerId, trashedNodeId)).rejects.toMatchObject({ status: 404 });
    await expect(sharing.getState(viewerId, nodeId)).resolves.toEqual({
      nodeId,
      generalAccessRole: GeneralAccessRole.RESTRICTED,
      documentUrl: `https://dochub.example.test/document/${nodeId}?usp=share_link`,
      canManageSharing: false,
    });
    await expect(sharing.updateGeneralAccess(viewerId, nodeId, { generalAccessRole: GeneralAccessRole.VIEWER })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps one canonical URL across General Access changes and repeated Copy reads', async () => {
    const first = await sharing.getState(ownerId, nodeId);
    expect(first.documentUrl).toBe(`https://dochub.example.test/document/${nodeId}?usp=share_link`);
    const firstCopiedUrl = (await sharing.getState(ownerId, nodeId)).documentUrl;
    expect(firstCopiedUrl).toBe(first.documentUrl);

    const roles = [GeneralAccessRole.VIEWER, GeneralAccessRole.EDITOR, GeneralAccessRole.RESTRICTED, GeneralAccessRole.VIEWER];
    for (const role of roles) {
      await sharing.updateGeneralAccess(ownerId, nodeId, { generalAccessRole: role });
      const state = await sharing.getState(ownerId, nodeId);
      expect(state.nodeId).toBe(nodeId);
      expect(state.documentUrl).toBe(first.documentUrl);
      expect(state.generalAccessRole).toBe(role);
    }
    const reads = await Promise.all(Array.from({ length: 8 }, () => sharing.getState(ownerId, nodeId)));
    expect(reads.map(({ documentUrl }) => documentUrl)).toEqual(Array(8).fill(first.documentUrl));
  });

  it('keeps the same URL after rename, move, direct user ACL, and group ACL changes', async () => {
    const canonicalUrl = (await sharing.getState(ownerId, nodeId)).documentUrl;
    const stableId = nodeId;
    await prisma.node.update({
      where: { id: nodeId },
      data: { name: `renamed-${suffix}`, normalizedName: `renamed-${suffix}`, parentId },
    });
    await prisma.permissionEntry.update({
      where: { nodeId_userId: { nodeId, userId: viewerId } },
      data: { role: DocumentRole.EDITOR },
    });
    await prisma.permissionEntry.create({
      data: { nodeId, groupId, role: DocumentRole.VIEWER, createdById: ownerId },
    });
    await prisma.groupMember.create({ data: { groupId, userId: viewerId, addedById: ownerId } });
    const after = await sharing.getState(ownerId, nodeId);
    expect(after.nodeId).toBe(stableId);
    expect(after.documentUrl).toBe(canonicalUrl);
    expect(await prisma.node.findUniqueOrThrow({ where: { id: nodeId } })).toMatchObject({
      id: stableId,
      parentId,
      name: `renamed-${suffix}`,
    });
  });

  it('hides trashed nodes from sharing management', async () => {
    await expect(sharing.updateGeneralAccess(ownerId, trashedNodeId, { generalAccessRole: GeneralAccessRole.VIEWER })).rejects.toMatchObject({ status: 404 });
  });

  it('rejects invalid roles and unknown sharing settings fields', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    const metadata = { type: 'body' as const, metatype: UpdateSharingDto, data: '' };
    await expect(pipe.transform({ generalAccessRole: 'not-a-role' }, metadata)).rejects.toMatchObject({ status: 400 });
    await expect(pipe.transform({ generalAccessRole: 'VIEWER', extra: true }, metadata)).rejects.toMatchObject({ status: 400 });
  });
});
