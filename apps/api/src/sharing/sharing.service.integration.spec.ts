import { createHash, randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import {
  AuditActorType,
  DocumentRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SharingService } from './sharing.service.js';
import { UpdateSharingDto } from './dto/update-sharing.dto.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase('SharingService integration', () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const invisibleId = randomUUID();
  const adminId = randomUUID();
  const nodeIds = new Set<string>();
  const operationIds = new Set<string>();
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const sharing = new SharingService(database, authorization, {
    webOrigin: 'https://dochub.example.test/',
  } as never);
  let nodeId: string;
  let trashedNodeId: string;
  let initialToken: string;

  async function node(name: string): Promise<string> {
    const record = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
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

  function token(url: string): string {
    return new URL(url).pathname.split('/').at(-1)!;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          email: `sharing-owner-${suffix}@example.test`,
          normalizedEmail: `sharing-owner-${suffix}@example.test`,
          displayName: 'Sharing owner',
          status: UserStatus.ACTIVE,
        },
        {
          id: viewerId,
          email: `sharing-viewer-${suffix}@example.test`,
          normalizedEmail: `sharing-viewer-${suffix}@example.test`,
          displayName: 'Sharing viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: invisibleId,
          email: `sharing-invisible-${suffix}@example.test`,
          normalizedEmail: `sharing-invisible-${suffix}@example.test`,
          displayName: 'Sharing invisible',
          status: UserStatus.ACTIVE,
        },
        {
          id: adminId,
          email: `sharing-admin-${suffix}@example.test`,
          normalizedEmail: `sharing-admin-${suffix}@example.test`,
          displayName: 'Sharing administrator',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
      ],
    });
    nodeId = await node('sharing-node');
    trashedNodeId = await node('sharing-trashed');
    await prisma.permissionEntry.create({
      data: { nodeId, userId: viewerId, role: DocumentRole.VIEWER },
    });
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: trashedNodeId,
        trashedById: ownerId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    operationIds.add(operation.id);
    await prisma.node.update({
      where: { id: trashedNodeId },
      data: { trashOperationId: operation.id },
    });
  });

  afterAll(async () => {
    const ids = [...nodeIds];
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.shareLink.deleteMany({ where: { nodeId: { in: ids } } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    await prisma.node.updateMany({
      where: { id: { in: ids } },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.node.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, viewerId, invisibleId, adminId] } },
    });
    await prisma.$disconnect();
  });

  it('reports safe state and enforces normal VIEW/SHARE authorization', async () => {
    await expect(sharing.getState(ownerId, nodeId)).resolves.toEqual({
      nodeId,
      publicAccess: false,
      shareLink: { exists: false },
      canManageSharing: true,
    });
    await expect(sharing.getState(viewerId, nodeId)).resolves.toEqual({
      nodeId,
      publicAccess: false,
      shareLink: { exists: false },
      canManageSharing: false,
    });
    await expect(sharing.ensureLink(viewerId, nodeId)).rejects.toMatchObject({
      status: 403,
    });
    for (const userId of [invisibleId, adminId]) {
      await expect(sharing.getState(userId, nodeId)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it('creates a hashed canonical link once without changing ACLs or exposing secrets later', async () => {
    const permissionsBefore = await prisma.permissionEntry.findMany({
      where: { nodeId },
      orderBy: { id: 'asc' },
    });
    const created = await sharing.ensureLink(ownerId, nodeId);
    expect(created.shareLink.created).toBe(true);
    expect(created.shareLink.url).toMatch(
      /^https:\/\/dochub\.example\.test\/share\//,
    );
    expect(created).not.toHaveProperty('tokenHash');
    const plaintext = token(created.shareLink.url!);
    initialToken = plaintext;
    const link = await prisma.shareLink.findUniqueOrThrow({
      where: {
        tokenHash: createHash('sha256').update(plaintext).digest('hex'),
      },
    });
    expect(link.tokenHash).not.toBe(plaintext);
    expect(JSON.stringify(link)).not.toContain(plaintext);
    expect(link.createdById).toBe(ownerId);

    await expect(sharing.getState(ownerId, nodeId)).resolves.toEqual({
      nodeId,
      publicAccess: false,
      shareLink: { exists: true },
      canManageSharing: true,
    });
    const existing = await sharing.ensureLink(ownerId, nodeId);
    expect(existing).toEqual({
      nodeId,
      shareLink: { id: link.id, created: false, url: null },
    });
    expect(
      await prisma.shareLink.count({ where: { nodeId, revokedAt: null } }),
    ).toBe(1);
    expect(
      await prisma.permissionEntry.findMany({
        where: { nodeId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(permissionsBefore);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: nodeId, action: 'SHARE_LINK_CREATED' },
      }),
    ).toBe(1);
  });

  it('keeps public access independent from ShareLinks and authenticated ACLs', async () => {
    const publicOnlyNodeId = await node('sharing-public-only');
    await sharing.updatePublicAccess(ownerId, publicOnlyNodeId, {
      publicAccess: true,
    });
    await expect(sharing.getState(ownerId, publicOnlyNodeId)).resolves.toEqual({
      nodeId: publicOnlyNodeId,
      publicAccess: true,
      shareLink: { exists: false },
      canManageSharing: true,
    });
    const permissionsBefore = await prisma.permissionEntry.findMany({
      where: { nodeId },
      orderBy: { id: 'asc' },
    });
    await expect(
      sharing.updatePublicAccess(ownerId, nodeId, { publicAccess: true }),
    ).resolves.toEqual({ nodeId, publicAccess: true });
    await expect(sharing.getState(invisibleId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(sharing.getState(adminId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      sharing.updatePublicAccess(ownerId, nodeId, { publicAccess: true }),
    ).resolves.toEqual({ nodeId, publicAccess: true });
    expect(
      await prisma.auditLog.count({
        where: { resourceId: nodeId, action: 'PUBLIC_ACCESS_CHANGED' },
      }),
    ).toBe(1);
    expect(
      await prisma.permissionEntry.findMany({
        where: { nodeId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(permissionsBefore);
  });

  it('resets, revokes, and audits links while retaining history and never auditing secrets', async () => {
    const permissionsBefore = await prisma.permissionEntry.findMany({
      where: { nodeId },
      orderBy: { id: 'asc' },
    });
    const prior = await prisma.shareLink.findFirstOrThrow({
      where: { nodeId, revokedAt: null },
    });
    const reset = await sharing.resetLink(ownerId, nodeId);
    const resetToken = token(reset.shareLink.url!);
    expect(resetToken).not.toBe(initialToken);
    const linksAfterReset = await prisma.shareLink.findMany({
      where: { nodeId },
    });
    expect(linksAfterReset).toHaveLength(2);
    expect(
      linksAfterReset.find((link) => link.id === prior.id)?.revokedAt,
    ).not.toBeNull();
    const active = linksAfterReset.find((link) => link.revokedAt === null)!;
    expect(active.tokenHash).toBe(
      createHash('sha256').update(resetToken).digest('hex'),
    );

    await sharing.revokeLink(ownerId, nodeId);
    await sharing.revokeLink(ownerId, nodeId);
    expect(
      await prisma.shareLink.count({ where: { nodeId, revokedAt: null } }),
    ).toBe(0);
    expect(await prisma.shareLink.count({ where: { nodeId } })).toBe(2);
    expect(
      await prisma.permissionEntry.findMany({
        where: { nodeId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(permissionsBefore);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: nodeId, action: 'SHARE_LINK_RESET' },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: nodeId, action: 'SHARE_LINK_REVOKED' },
      }),
    ).toBe(1);
    const audits = await prisma.auditLog.findMany({
      where: { resourceId: nodeId },
      select: { actorType: true, metadata: true },
    });
    expect(
      audits.every((audit) => audit.actorType === AuditActorType.USER),
    ).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(resetToken);
    expect(JSON.stringify(audits)).not.toContain(initialToken);
    expect(JSON.stringify(audits)).not.toContain(active.tokenHash);
  });

  it('hides trashed nodes from every sharing-management operation', async () => {
    await expect(
      sharing.getState(ownerId, trashedNodeId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharing.ensureLink(ownerId, trashedNodeId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharing.resetLink(ownerId, trashedNodeId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharing.revokeLink(ownerId, trashedNodeId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sharing.updatePublicAccess(ownerId, trashedNodeId, {
        publicAccess: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('serializes concurrent ensure and reset calls without leaking failed candidates', async () => {
    const concurrentNodeId = await node('sharing-concurrent');
    const ensured = await Promise.all([
      sharing.ensureLink(ownerId, concurrentNodeId),
      sharing.ensureLink(ownerId, concurrentNodeId),
    ]);
    expect(
      await prisma.shareLink.count({
        where: { nodeId: concurrentNodeId, revokedAt: null },
      }),
    ).toBe(1);
    expect(ensured.filter((result) => result.shareLink.created)).toHaveLength(
      1,
    );
    expect(
      ensured.filter((result) => result.shareLink.url !== null),
    ).toHaveLength(1);

    const reset = await Promise.all([
      sharing.resetLink(ownerId, concurrentNodeId),
      sharing.resetLink(ownerId, concurrentNodeId),
    ]);
    const links = await prisma.shareLink.findMany({
      where: { nodeId: concurrentNodeId },
    });
    expect(links.filter((link) => link.revokedAt === null)).toHaveLength(1);
    expect(
      reset.every((result) => {
        const hash = createHash('sha256')
          .update(token(result.shareLink.url!))
          .digest('hex');
        return links.some((link) => link.tokenHash === hash);
      }),
    ).toBe(true);
  });

  it('rejects string booleans and unknown sharing settings fields', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const metadata = { metatype: UpdateSharingDto, type: 'body' as const };
    await expect(
      pipe.transform({ publicAccess: 'true' }, metadata),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pipe.transform({ publicAccess: true, extra: true }, metadata),
    ).rejects.toMatchObject({ status: 400 });
  });
});
