import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { ShareResolutionService } from './share-resolution.service.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase('ShareResolutionService integration', () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const noAclId = randomUUID();
  const nodeIds: string[] = [];
  const operationIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const resolution = new ShareResolutionService(
    database,
    new DocumentAuthorizationService(database),
  );
  let nodeId: string;
  let token: string;

  async function activeLink(
    value = `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
  ) {
    await prisma.shareLink.create({
      data: {
        nodeId,
        createdById: ownerId,
        tokenHash: createHash('sha256').update(value).digest('hex'),
      },
    });
    return value;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          email: `share-resolution-owner-${suffix}@example.test`,
          normalizedEmail: `share-resolution-owner-${suffix}@example.test`,
          displayName: 'Owner',
          status: UserStatus.ACTIVE,
        },
        {
          id: noAclId,
          email: `share-resolution-no-acl-${suffix}@example.test`,
          normalizedEmail: `share-resolution-no-acl-${suffix}@example.test`,
          displayName: 'No ACL',
          status: UserStatus.ACTIVE,
        },
      ],
    });
    const node = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `share-resolution-${suffix}`,
        normalizedName: `share-resolution-${suffix}`,
        createdById: ownerId,
        publicAccess: true,
      },
    });
    nodeId = node.id;
    nodeIds.push(nodeId);
    await prisma.permissionEntry.create({
      data: { nodeId, userId: ownerId, role: DocumentRole.OWNER },
    });
    token = await activeLink();
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { resourceId: { in: nodeIds } },
    });
    await prisma.shareLink.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: { in: nodeIds } },
    });
    await prisma.node.updateMany({
      where: { id: { in: nodeIds } },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.deleteMany({
      where: { id: { in: operationIds } },
    });
    await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, noAclId] } } });
    await prisma.$disconnect();
  });

  it('uses only the token hash and supports public metadata', async () => {
    await expect(
      resolution.resolve(token, undefined, DocumentCapability.VIEW),
    ).resolves.toMatchObject({ mode: 'PUBLIC', node: { id: nodeId } });
    await expect(
      resolution.resolve(
        createHash('sha256').update(token).digest('hex'),
        undefined,
        DocumentCapability.VIEW,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('never falls back from authenticated ACL denial to public access', async () => {
    await expect(
      resolution.resolve(
        token,
        { userId: noAclId, sessionId: randomUUID() },
        DocumentCapability.VIEW,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      resolution.resolve(
        token,
        { userId: ownerId, sessionId: randomUUID() },
        DocumentCapability.VIEW,
      ),
    ).resolves.toMatchObject({ mode: 'AUTHENTICATED' });
  });

  it('honors publicAccess toggles and rejects anonymous download', async () => {
    await prisma.node.update({
      where: { id: nodeId },
      data: { publicAccess: false },
    });
    await expect(
      resolution.resolve(token, undefined, DocumentCapability.VIEW),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.node.update({
      where: { id: nodeId },
      data: { publicAccess: true },
    });
    await expect(
      resolution.resolve(token, undefined, DocumentCapability.DOWNLOAD),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('invalidates reset/revoked tokens immediately and hides trashed nodes until restore', async () => {
    await prisma.shareLink.updateMany({
      where: { nodeId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await expect(
      resolution.resolve(token, undefined, DocumentCapability.VIEW),
    ).rejects.toMatchObject({ status: 404 });
    const replacement = await activeLink();
    await expect(
      resolution.resolve(replacement, undefined, DocumentCapability.VIEW),
    ).resolves.toBeTruthy();
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: nodeId,
        trashedById: ownerId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    operationIds.push(operation.id);
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: operation.id },
    });
    await expect(
      resolution.resolve(replacement, undefined, DocumentCapability.VIEW),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: null },
    });
    await expect(
      resolution.resolve(replacement, undefined, DocumentCapability.VIEW),
    ).resolves.toBeTruthy();
  });
});
