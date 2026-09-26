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
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { SearchService } from './search.service.js';

const withDb = process.env.DATABASE_URL ? describe : describe.skip;
withDb('SearchService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const hiddenId = randomUUID();
  const adminId = randomUUID();
  const nodeIds: string[] = [];
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const search = new SearchService(database, authorization);
  async function node(name: string, type = NodeType.FOLDER, visible = true) {
    const row = await prisma.node.create({
      data: {
        type,
        name,
        normalizedName: `${name.toLowerCase()}-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(row.id);
    if (visible)
      await prisma.permissionEntry.create({
        data: { nodeId: row.id, userId: actorId, role: DocumentRole.VIEWER },
      });
    return row;
  }
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `search-${suffix}@x.test`,
          normalizedEmail: `search-${suffix}@x.test`,
          displayName: 'Search',
          status: UserStatus.ACTIVE,
        },
        {
          id: hiddenId,
          email: `hidden-${suffix}@x.test`,
          normalizedEmail: `hidden-${suffix}@x.test`,
          displayName: 'Hidden',
          status: UserStatus.ACTIVE,
        },
        {
          id: adminId,
          email: `admin-${suffix}@x.test`,
          normalizedEmail: `admin-${suffix}@x.test`,
          displayName: 'Admin',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
      ],
    });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { resourceId: { in: nodeIds } },
    });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: { in: nodeIds } },
    });
    await prisma.node.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, hiddenId, adminId] } },
    });
    await prisma.$disconnect();
  });
  it('matches names with relevance, accents, types, ACL filtering, and opaque pagination', async () => {
    const exact = await node('Báo cáo');
    await node('Báo cáo tháng 9');
    await node('Tổng hợp báo cáo');
    const plan = await node('Kế hoạch nhân sự', NodeType.FILE);
    await node('Bao hidden', NodeType.FILE, false);
    await node('Bao public', NodeType.FOLDER, false).then((row) =>
      prisma.node.update({
        where: { id: row.id },
        data: { publicAccess: true },
      }),
    );
    const report = await search.search(actorId, { q: 'bao cao', limit: 2 });
    expect(report.items[0]?.id).toBe(exact.id);
    expect(report.items.map((x) => x.id)).not.toContain(plan.id);
    expect(
      (await search.search(actorId, { q: 'ke hoach nhan su' })).items.map(
        (x) => x.id,
      ),
    ).toContain(plan.id);
    expect(
      (
        await search.search(actorId, {
          q: 'KE HOACH NHAN SU',
          type: NodeType.FILE,
        })
      ).items.map((x) => x.id),
    ).toContain(plan.id);
    expect(
      (await search.search(actorId, { q: 'bao', type: NodeType.FILE })).items,
    ).toHaveLength(0);
    expect(
      report.items.every(
        (x) => !x.name.includes('hidden') && !x.name.includes('public'),
      ),
    ).toBe(true);
    if (report.nextCursor) {
      const page2 = await search.search(actorId, {
        q: 'bao cao',
        limit: 2,
        cursor: report.nextCursor,
      });
      expect(
        page2.items
          .map((x) => x.id)
          .some((id) => report.items.some((first) => first.id === id)),
      ).toBe(false);
    }
  });
  it('matches bulk capability resolution to scalar capability sets', async () => {
    const target = await node(`Parity ${suffix}`);
    const bulk = await authorization.resolveCapabilitiesForNodes(actorId, [
      target.id,
    ]);
    const scalar = await authorization.resolveCapabilities(actorId, target.id);
    expect([...bulk.get(target.id)!.capabilities].sort()).toEqual(
      [...scalar.capabilities].sort(),
    );
    expect(bulk.get(target.id)!.capabilities.has(DocumentCapability.VIEW)).toBe(
      true,
    );
  });

  it('keeps bulk and scalar authorization identical across direct, group, inherited, boundary, and no-bypass cases', async () => {
    const groupId = randomUUID();
    await prisma.group.create({
      data: {
        id: groupId,
        name: `search-group-${suffix}`,
        normalizedName: `search-group-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.groupMember.create({
      data: { groupId, userId: actorId, addedById: actorId },
    });
    const directEditor = await node(`Direct editor ${suffix}`);
    await prisma.permissionEntry.update({
      where: { nodeId_userId: { nodeId: directEditor.id, userId: actorId } },
      data: { role: DocumentRole.EDITOR },
    });
    const groupOwner = await node(
      `Group owner ${suffix}`,
      NodeType.FOLDER,
      false,
    );
    await prisma.permissionEntry.create({
      data: { nodeId: groupOwner.id, groupId, role: DocumentRole.OWNER },
    });
    const inheritedRoot = await node(`Inherited root ${suffix}`);
    const inheritedChild = await prisma.node.create({
      data: {
        parentId: inheritedRoot.id,
        type: NodeType.FILE,
        name: `Inherited child ${suffix}`,
        normalizedName: `inherited-child-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(inheritedChild.id);
    const boundary = await prisma.node.create({
      data: {
        parentId: inheritedRoot.id,
        type: NodeType.FOLDER,
        name: `Boundary ${suffix}`,
        normalizedName: `boundary-${randomUUID()}`,
        inheritPermissions: false,
        createdById: actorId,
      },
    });
    nodeIds.push(boundary.id);
    const boundaryChild = await prisma.node.create({
      data: {
        parentId: boundary.id,
        type: NodeType.FILE,
        name: `Boundary child ${suffix}`,
        normalizedName: `boundary-child-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(boundaryChild.id);
    await prisma.permissionEntry.create({
      data: {
        nodeId: boundaryChild.id,
        userId: actorId,
        role: DocumentRole.VIEWER,
      },
    });
    const noAccess = await node(`No access ${suffix}`, NodeType.FOLDER, false);
    const ids = [
      directEditor.id,
      groupOwner.id,
      inheritedChild.id,
      boundaryChild.id,
      boundary.id,
      noAccess.id,
    ];
    const bulk = await authorization.resolveCapabilitiesForNodes(actorId, ids);
    for (const id of ids) {
      const scalar = await authorization.resolveCapabilities(actorId, id);
      expect([...bulk.get(id)!.capabilities].sort()).toEqual(
        [...scalar.capabilities].sort(),
      );
    }
    expect(bulk.get(boundary.id)!.capabilities).toEqual(new Set());
    expect(
      bulk.get(boundaryChild.id)!.capabilities.has(DocumentCapability.VIEW),
    ).toBe(true);
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.group.delete({ where: { id: groupId } });
  });

  it('handles prefix, substring, fuzzy, special characters, rename, and trash freshness', async () => {
    const prefix = await node(`Bao prefix ${suffix}`);
    const substring = await node(`Tổng hợp bao suffix ${suffix}`);
    const fuzzy = await node('Kế hoạch nhân sự typo');
    const special = await node(`100% _ quote' slash\\ ${suffix}`);
    const prefixResults = await search.search(actorId, { q: 'bao', limit: 20 });
    expect(
      prefixResults.items.findIndex((item) => item.id === prefix.id),
    ).toBeLessThan(
      prefixResults.items.findIndex((item) => item.id === substring.id),
    );
    expect(
      (await search.search(actorId, { q: 'hop bao' })).items.map(
        (item) => item.id,
      ),
    ).toContain(substring.id);
    expect(
      (await search.search(actorId, { q: 'ke hoah nhan su' })).items.map(
        (item) => item.id,
      ),
    ).toContain(fuzzy.id);
    for (const query of ['%', '_', "quote'", '"', '\\', 'Kế hoạch'])
      await expect(search.search(actorId, { q: query })).resolves.toBeTruthy();
    await prisma.node.update({
      where: { id: special.id },
      data: { name: `Renamed ${suffix}` },
    });
    expect(
      (await search.search(actorId, { q: 'quote' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(special.id);
    expect(
      (await search.search(actorId, { q: 'renamed' })).items.map(
        (item) => item.id,
      ),
    ).toContain(special.id);
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: prefix.id,
        trashedById: actorId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.node.update({
      where: { id: prefix.id },
      data: { trashOperationId: operation.id },
    });
    expect(
      (await search.search(actorId, { q: 'bao prefix' })).items.map(
        (item) => item.id,
      ),
    ).not.toContain(prefix.id);
    await prisma.node.update({
      where: { id: prefix.id },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
    expect(
      (await search.search(actorId, { q: 'bao prefix' })).items.map(
        (item) => item.id,
      ),
    ).toContain(prefix.id);
  });
});
