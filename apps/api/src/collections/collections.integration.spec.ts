import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { CollectionsService } from './collections.service.js';

const withDb = process.env.DATABASE_URL ? describe : describe.skip;

withDb('CollectionsService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const otherId = randomUUID();
  const adminId = randomUUID();
  const nodeIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const collections = new CollectionsService(database, authorization);

  async function node(name: string, visibleToActor = true) {
    const row = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `${name}-${suffix}`,
        normalizedName: `${name}-${suffix}`.toLowerCase(),
        createdById: actorId,
      },
    });
    nodeIds.push(row.id);
    if (visibleToActor)
      await prisma.permissionEntry.create({
        data: { nodeId: row.id, userId: actorId, role: DocumentRole.VIEWER },
      });
    return row;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: actorId, email: `collections-${suffix}@x.test`, normalizedEmail: `collections-${suffix}@x.test`, displayName: 'Collections', status: UserStatus.ACTIVE },
        { id: otherId, email: `collections-other-${suffix}@x.test`, normalizedEmail: `collections-other-${suffix}@x.test`, displayName: 'Other', status: UserStatus.ACTIVE },
        { id: adminId, email: `collections-admin-${suffix}@x.test`, normalizedEmail: `collections-admin-${suffix}@x.test`, displayName: 'Admin', status: UserStatus.ACTIVE, systemRole: SystemRole.ADMIN },
      ],
    });
  });

  afterAll(async () => {
    await prisma.recentItem.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await prisma.favorite.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [actorId, otherId, adminId] } } });
    await prisma.$disconnect();
  });

  it('upserts recency, orders it, and keeps it per user', async () => {
    const first = await node('recent-first');
    const second = await node('recent-second');
    await collections.recordRecent(actorId, first.id);
    await collections.recordRecent(actorId, first.id);
    expect(await prisma.recentItem.count({ where: { userId: actorId, nodeId: first.id } })).toBe(1);
    await prisma.recentItem.update({ where: { userId_nodeId: { userId: actorId, nodeId: first.id } }, data: { lastAccessedAt: new Date(0) } });
    await collections.recordRecent(actorId, second.id);
    await prisma.permissionEntry.create({ data: { nodeId: first.id, userId: otherId, role: DocumentRole.VIEWER } });
    await collections.recordRecent(otherId, first.id);
    expect((await collections.listRecent(actorId)).items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect((await collections.listRecent(otherId)).items.map((item) => item.id)).toEqual([first.id]);
  });

  it('filters recent items after ACL removal and while trashed', async () => {
    const target = await node('recent-filter');
    await collections.recordRecent(actorId, target.id);
    await prisma.permissionEntry.deleteMany({ where: { nodeId: target.id, userId: actorId } });
    expect((await collections.listRecent(actorId)).items.map((item) => item.id)).not.toContain(target.id);
    await prisma.permissionEntry.create({ data: { nodeId: target.id, userId: actorId, role: DocumentRole.VIEWER } });
    const operation = await prisma.trashOperation.create({ data: { rootNodeId: target.id, trashedById: actorId, expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.node.update({ where: { id: target.id }, data: { trashOperationId: operation.id } });
    expect((await collections.listRecent(actorId)).items.map((item) => item.id)).not.toContain(target.id);
  });

  it('adds and removes favorites idempotently without granting access', async () => {
    const target = await node('favorite-target');
    await expect(collections.addFavorite(actorId, target.id)).resolves.toEqual({ nodeId: target.id, favorited: true });
    await collections.addFavorite(actorId, target.id);
    expect(await prisma.favorite.count({ where: { userId: actorId, nodeId: target.id } })).toBe(1);
    expect((await collections.listFavorites(actorId)).items.map((item) => item.id)).toContain(target.id);
    await expect(collections.addFavorite(adminId, target.id)).rejects.toMatchObject({ status: 404 });
    await collections.removeFavorite(actorId, target.id);
    await collections.removeFavorite(actorId, target.id);
    expect(await prisma.favorite.count({ where: { userId: actorId, nodeId: target.id } })).toBe(0);
  });

  it('filters favorites after ACL removal and relies on node cascade on permanent deletion', async () => {
    const target = await node('favorite-filter');
    await collections.addFavorite(actorId, target.id);
    await prisma.permissionEntry.deleteMany({ where: { nodeId: target.id, userId: actorId } });
    expect((await collections.listFavorites(actorId)).items.map((item) => item.id)).not.toContain(target.id);
    await prisma.node.delete({ where: { id: target.id } });
    expect(await prisma.favorite.findUnique({ where: { userId_nodeId: { userId: actorId, nodeId: target.id } } })).toBeNull();
    nodeIds.splice(nodeIds.indexOf(target.id), 1);
  });
});
