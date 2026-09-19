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
import { NodesService } from './nodes.service.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase('NodesService integration', () => {
  const suffix = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const memberId = randomUUID();
  const nodeIds = new Set<string>();
  const trashOperationIds = new Set<string>();
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const nodes = new NodesService(database, authorization);
  let rootId: string;
  let otherRootId: string;
  let hiddenRootId: string;
  let childId: string;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          email: `nodes-admin-${suffix}@example.test`,
          normalizedEmail: `nodes-admin-${suffix}@example.test`,
          displayName: 'Nodes administrator',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
        {
          id: editorId,
          email: `nodes-editor-${suffix}@example.test`,
          normalizedEmail: `nodes-editor-${suffix}@example.test`,
          displayName: 'Nodes editor',
          status: UserStatus.ACTIVE,
        },
        {
          id: viewerId,
          email: `nodes-viewer-${suffix}@example.test`,
          normalizedEmail: `nodes-viewer-${suffix}@example.test`,
          displayName: 'Nodes viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: memberId,
          email: `nodes-member-${suffix}@example.test`,
          normalizedEmail: `nodes-member-${suffix}@example.test`,
          displayName: 'Nodes member',
          status: UserStatus.ACTIVE,
        },
      ],
    });

    const root = await nodes.createFolder(adminId, { name: `Root ${suffix}` });
    rootId = root.id;
    nodeIds.add(rootId);
    const otherRoot = await nodes.createFolder(adminId, {
      name: `Other ${suffix}`,
    });
    otherRootId = otherRoot.id;
    nodeIds.add(otherRootId);
    const hiddenRoot = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `Hidden ${suffix}`,
        normalizedName: `hidden ${suffix}`,
        createdById: adminId,
      },
    });
    hiddenRootId = hiddenRoot.id;
    nodeIds.add(hiddenRootId);
    await prisma.permissionEntry.createMany({
      data: [
        { nodeId: rootId, userId: editorId, role: DocumentRole.OWNER },
        { nodeId: otherRootId, userId: editorId, role: DocumentRole.OWNER },
      ],
    });
  });

  afterAll(async () => {
    const ids = [...nodeIds];
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    const hierarchy = await prisma.node.findMany({
      where: { id: { in: ids } },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(
      hierarchy.map((node) => [node.id, node.parentId]),
    );
    const depth = (id: string): number => {
      const parentId = parentById.get(id);
      return parentId && parentById.has(parentId) ? depth(parentId) + 1 : 0;
    };
    for (const node of [...hierarchy].sort(
      (left, right) => depth(right.id) - depth(left.id),
    )) {
      await prisma.node.deleteMany({ where: { id: node.id } });
    }
    await prisma.trashOperation.deleteMany({
      where: { id: { in: [...trashOperationIds] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, editorId, viewerId, memberId] } },
    });
    await prisma.$disconnect();
  });

  it('allows only an active administrator to create a root folder and creates owner ACL and audit atomically', async () => {
    await expect(
      nodes.createFolder(memberId, { name: `Member root ${suffix}` }),
    ).rejects.toMatchObject({ status: 403 });

    const created = await nodes.createFolder(adminId, {
      name: `Created root ${suffix}`,
    });
    nodeIds.add(created.id);
    expect(created.capabilities).toContain(
      DocumentCapability.MANAGE_PERMISSION,
    );
    await expect(
      prisma.permissionEntry.findFirstOrThrow({
        where: {
          nodeId: created.id,
          userId: adminId,
          role: DocumentRole.OWNER,
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { resourceId: created.id, action: 'FOLDER_CREATED' },
      }),
    ).resolves.toBeTruthy();
  });

  it('creates children from CREATE, validates parent type, and uses database uniqueness', async () => {
    const child = await nodes.createFolder(editorId, {
      name: 'Project  Plan',
      parentId: rootId,
    });
    childId = child.id;
    nodeIds.add(child.id);
    await expect(
      nodes.createFolder(editorId, { name: 'project  plan', parentId: rootId }),
    ).rejects.toMatchObject({ status: 409 });

    const sameNameElsewhere = await nodes.createFolder(editorId, {
      name: 'project  plan',
      parentId: otherRootId,
    });
    nodeIds.add(sameNameElsewhere.id);
    const fileParent = await prisma.node.create({
      data: {
        type: NodeType.FILE,
        name: `file-${suffix}`,
        normalizedName: `file-${suffix}`,
        parentId: rootId,
        createdById: adminId,
      },
    });
    nodeIds.add(fileParent.id);
    await prisma.permissionEntry.create({
      data: {
        nodeId: fileParent.id,
        userId: editorId,
        role: DocumentRole.OWNER,
      },
    });
    await expect(
      nodes.createFolder(editorId, {
        name: 'Not allowed',
        parentId: fileParent.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('enforces ACL-only root and child visibility with stable cursor pagination', async () => {
    await expect(nodes.getNode(adminId, hiddenRootId)).rejects.toMatchObject({
      status: 404,
    });
    const rootPage = await nodes.listRoot(editorId, { limit: 1 });
    expect(rootPage.items).toHaveLength(1);
    expect(rootPage.items[0].capabilities).toContain(DocumentCapability.VIEW);
    expect(rootPage.nextCursor).not.toBeNull();
    const nextPage = await nodes.listRoot(editorId, {
      limit: 10,
      cursor: rootPage.nextCursor ?? undefined,
    });
    expect(nextPage.items.map((node) => node.id)).not.toContain(
      rootPage.items[0].id,
    );

    const hiddenChild = await prisma.node.create({
      data: {
        parentId: rootId,
        type: NodeType.FOLDER,
        name: `hidden-child-${suffix}`,
        normalizedName: `hidden-child-${suffix}`,
        inheritPermissions: false,
        createdById: adminId,
      },
    });
    nodeIds.add(hiddenChild.id);
    const visibleChild = await prisma.node.create({
      data: {
        parentId: rootId,
        type: NodeType.FOLDER,
        name: `visible-child-${suffix}`,
        normalizedName: `visible-child-${suffix}`,
        inheritPermissions: false,
        createdById: adminId,
      },
    });
    nodeIds.add(visibleChild.id);
    await prisma.permissionEntry.create({
      data: {
        nodeId: visibleChild.id,
        userId: editorId,
        role: DocumentRole.VIEWER,
      },
    });
    const children = await nodes.listChildren(editorId, rootId, { limit: 100 });
    expect(children.items.map((node) => node.id)).toContain(childId);
    expect(children.items.map((node) => node.id)).not.toContain(hiddenChild.id);
    expect(children.items.map((node) => node.id)).toContain(visibleChild.id);
    await expect(
      nodes.listRoot(editorId, { cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns only the accessible breadcrumb suffix', async () => {
    const secret = await prisma.node.create({
      data: {
        parentId: rootId,
        type: NodeType.FILE,
        name: `secret-${suffix}`,
        normalizedName: `secret-${suffix}`,
        inheritPermissions: false,
        createdById: adminId,
      },
    });
    nodeIds.add(secret.id);
    await prisma.permissionEntry.create({
      data: { nodeId: secret.id, userId: viewerId, role: DocumentRole.VIEWER },
    });
    const breadcrumb = await nodes.breadcrumb(viewerId, secret.id);
    expect(breadcrumb).toEqual({
      items: [{ id: secret.id, name: secret.name, type: NodeType.FILE }],
      truncated: true,
    });
  });

  it('renames with RENAME, updates actor/audit, and keeps viewer attempts forbidden', async () => {
    await prisma.permissionEntry.create({
      data: { nodeId: childId, userId: viewerId, role: DocumentRole.VIEWER },
    });
    await expect(
      nodes.renameNode(viewerId, childId, { name: 'Nope' }),
    ).rejects.toMatchObject({ status: 403 });
    const renamed = await nodes.renameNode(editorId, childId, {
      name: 'Renamed Project',
    });
    expect(renamed.name).toBe('Renamed Project');
    await expect(
      prisma.node.findFirstOrThrow({
        where: {
          id: childId,
          updatedById: editorId,
          normalizedName: 'renamed project',
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { resourceId: childId, action: 'NODE_RENAMED' },
      }),
    ).resolves.toBeTruthy();
  });

  it('moves serializably, rejects cycles, preserves ACLs/inheritance, and audits', async () => {
    const destination = await nodes.createFolder(editorId, {
      name: `destination-${suffix}`,
      parentId: rootId,
    });
    nodeIds.add(destination.id);
    const descendant = await nodes.createFolder(editorId, {
      name: `descendant-${suffix}`,
      parentId: childId,
    });
    nodeIds.add(descendant.id);
    await expect(
      nodes.moveNode(editorId, childId, { parentId: descendant.id }),
    ).rejects.toMatchObject({ status: 409 });
    const permissionCount = await prisma.permissionEntry.count({
      where: { nodeId: childId },
    });
    const moved = await nodes.moveNode(editorId, childId, {
      parentId: destination.id,
    });
    expect(moved.parentId).toBe(destination.id);
    expect(
      await prisma.permissionEntry.count({ where: { nodeId: childId } }),
    ).toBe(permissionCount);
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { resourceId: childId, action: 'NODE_MOVED' },
      }),
    ).resolves.toBeTruthy();

    await expect(
      nodes.moveNode(editorId, childId, { parentId: null }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await prisma.permissionEntry.create({
      data: { nodeId: childId, userId: adminId, role: DocumentRole.OWNER },
    });
    const rootMoved = await nodes.moveNode(adminId, childId, {
      parentId: null,
    });
    expect(rootMoved.parentId).toBeNull();
  });

  it('allows a name held only by a trashed node to be reused', async () => {
    const trashed = await prisma.node.create({
      data: {
        parentId: rootId,
        type: NodeType.FOLDER,
        name: `reusable-${suffix}`,
        normalizedName: `reusable-${suffix}`,
        createdById: adminId,
      },
    });
    nodeIds.add(trashed.id);
    const operation = await prisma.trashOperation.create({
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    trashOperationIds.add(operation.id);
    await prisma.node.update({
      where: { id: trashed.id },
      data: { trashOperationId: operation.id },
    });
    const replacement = await nodes.createFolder(editorId, {
      name: `reusable-${suffix}`,
      parentId: rootId,
    });
    nodeIds.add(replacement.id);
    expect(replacement.id).not.toBe(trashed.id);
  });

  it('does not permit concurrent reciprocal moves to commit a cycle', async () => {
    const first = await nodes.createFolder(editorId, {
      name: `concurrent-first-${suffix}`,
      parentId: rootId,
    });
    const second = await nodes.createFolder(editorId, {
      name: `concurrent-second-${suffix}`,
      parentId: rootId,
    });
    nodeIds.add(first.id);
    nodeIds.add(second.id);

    const results = await Promise.allSettled([
      nodes.moveNode(editorId, first.id, { parentId: second.id }),
      nodes.moveNode(editorId, second.id, { parentId: first.id }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const finalNodes = await prisma.node.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(
      finalNodes.map((node) => [node.id, node.parentId]),
    );
    expect(
      parentById.get(first.id) === second.id &&
        parentById.get(second.id) === first.id,
    ).toBe(false);
  });
});
