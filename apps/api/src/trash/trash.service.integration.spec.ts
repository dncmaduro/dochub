import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DocumentRole,
  EditorActorType,
  EditorMode,
  FileProcessingTaskType,
  NodeType,
  prisma,
  SystemRole,
  TrashOperationStatus,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { TrashService } from './trash.service.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;
describeWithDatabase('TrashService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const viewerId = randomUUID();
  const editorId = randomUUID();
  const invisibleId = randomUUID();
  const adminId = randomUUID();
  const groupId = randomUUID();
  const nodeIds: string[] = [];
  const userIds = [actorId, viewerId, editorId, invisibleId, adminId];
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const storage = { delete: vi.fn().mockResolvedValue(undefined) };
  const service = new TrashService(
    database,
    authorization,
    {
      ...storage,
    } as never,
    {
      retentionDays: 30,
    },
  );
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `trash-${suffix}@example.test`,
          normalizedEmail: `trash-${suffix}@example.test`,
          displayName: 'Trash owner',
          status: UserStatus.ACTIVE,
        },
        {
          id: viewerId,
          email: `trash-viewer-${suffix}@example.test`,
          normalizedEmail: `trash-viewer-${suffix}@example.test`,
          displayName: 'Trash viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: editorId,
          email: `trash-editor-${suffix}@example.test`,
          normalizedEmail: `trash-editor-${suffix}@example.test`,
          displayName: 'Trash editor',
          status: UserStatus.ACTIVE,
        },
        {
          id: invisibleId,
          email: `trash-invisible-${suffix}@example.test`,
          normalizedEmail: `trash-invisible-${suffix}@example.test`,
          displayName: 'Trash invisible',
          status: UserStatus.ACTIVE,
        },
        {
          id: adminId,
          email: `trash-admin-${suffix}@example.test`,
          normalizedEmail: `trash-admin-${suffix}@example.test`,
          displayName: 'Trash admin',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
      ],
    });
    await prisma.group.create({
      data: {
        id: groupId,
        name: `trash-group-${suffix}`,
        normalizedName: `trash-group-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.groupMember.create({
      data: { groupId, userId: actorId, addedById: actorId },
    });
  });
  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ actorId: { in: userIds } }, { resourceId: { in: nodeIds } }],
      },
    });
    await prisma.node.updateMany({
      where: { id: { in: nodeIds } },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.deleteMany({
      where: {
        OR: [{ rootNodeId: { in: nodeIds } }, { trashedById: { in: userIds } }],
      },
    });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: { in: nodeIds } },
    });
    const files = await prisma.file.findMany({
      where: { nodeId: { in: nodeIds } },
      select: { id: true },
    });
    await prisma.editorSession.deleteMany({
      where: {
        OR: [
          { fileId: { in: files.map((file) => file.id) } },
          { shareLink: { nodeId: { in: nodeIds } } },
        ],
      },
    });
    await prisma.shareLink.deleteMany({ where: { nodeId: { in: nodeIds } } });
    if (files.length > 0) {
      await prisma.file.updateMany({
        where: { id: { in: files.map((file) => file.id) } },
        data: { currentVersionId: null },
      });
      await prisma.fileVersion.deleteMany({
        where: { fileId: { in: files.map((file) => file.id) } },
      });
      await prisma.file.deleteMany({
        where: { id: { in: files.map((file) => file.id) } },
      });
    }
    await prisma.groupMember.deleteMany({ where: { groupId } });
    await prisma.group.deleteMany({ where: { id: groupId } });
    const rows = await prisma.node.findMany({
      where: { id: { in: nodeIds } },
      select: { id: true, parentId: true },
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentId]));
    const depth = (id: string): number => {
      const parent = parents.get(id);
      return parent && parents.has(parent) ? depth(parent) + 1 : 0;
    };
    for (const row of rows.sort((a, b) => depth(b.id) - depth(a.id)))
      await prisma.node.deleteMany({ where: { id: row.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });
  async function node(
    parentId: string | null,
    name: string,
    type: NodeType = NodeType.FOLDER,
  ) {
    const record = await prisma.node.create({
      data: {
        parentId,
        type,
        name,
        normalizedName: `${name}-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(record.id);
    return record;
  }

  async function file(nodeId: string, versionCount = 2) {
    const id = randomUUID();
    await prisma.file.create({
      data: { id, nodeId, versionCounter: versionCount },
    });
    const versions = await Promise.all(
      Array.from({ length: versionCount }, async (_, index) => {
        const versionId = randomUUID();
        return prisma.fileVersion.create({
          data: {
            id: versionId,
            fileId: id,
            versionNumber: index + 1,
            storageKey: `purge/${id}/${versionId}`,
            originalFilename: 'purge.pdf',
            mimeType: 'application/pdf',
            extension: 'pdf',
            sizeBytes: BigInt(index + 1),
            sha256: String(index + 1).repeat(64),
            source: 'UPLOAD',
            createdById: actorId,
          },
        });
      }),
    );
    await prisma.file.update({
      where: { id },
      data: { currentVersionId: versions.at(-1)?.id },
    });
    return { id, versions };
  }
  it('trashes an active subtree once and preserves active-name reuse', async () => {
    const root = await node(null, 'root'),
      child = await node(root.id, 'child'),
      leaf = await node(child.id, 'leaf', NodeType.FILE);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const result = await service.trash(actorId, root.id);
    expect(result.affectedNodeCount).toBe(3);
    expect(
      await prisma.node.findMany({
        where: { id: { in: [root.id, child.id, leaf.id] } },
        select: { trashOperationId: true },
      }),
    ).toEqual(
      expect.arrayContaining([{ trashOperationId: result.operation.id }]),
    );
    const replacement = await prisma.node.create({
      data: {
        parentId: null,
        type: NodeType.FOLDER,
        name: 'root',
        normalizedName: `root-${randomUUID()}`,
        createdById: actorId,
      },
    });
    nodeIds.push(replacement.id);
    await expect(service.trash(actorId, root.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('keeps an older nested trash operation and counts only newly tagged nodes', async () => {
    const a = await node(null, 'a'),
      b = await node(a.id, 'b'),
      c = await node(b.id, 'c');
    await prisma.permissionEntry.create({
      data: { nodeId: a.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const old = await service.trash(actorId, c.id);
    const newer = await service.trash(actorId, a.id);
    expect(newer.affectedNodeCount).toBe(2);
    expect(
      (await prisma.node.findUniqueOrThrow({ where: { id: c.id } }))
        .trashOperationId,
    ).toBe(old.operation.id);
  });
  it('allows only one concurrent effective trash operation', async () => {
    const root = await node(null, 'concurrent'),
      child = await node(root.id, 'concurrent-child');
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const results = await Promise.allSettled([
      service.trash(actorId, root.id),
      service.trash(actorId, root.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const nodes = await prisma.node.findMany({
      where: { id: { in: [root.id, child.id] } },
      select: { trashOperationId: true },
    });
    expect(new Set(nodes.map((n) => n.trashOperationId))).toHaveLength(1);
  });

  it('restores a root folder subtree, preserves its shape, and makes normal ACL resolution available again', async () => {
    const a = await node(null, 'restore-a'),
      b = await node(a.id, 'restore-b'),
      c = await node(a.id, 'restore-c'),
      d = await node(c.id, 'restore-d', NodeType.FILE);
    await prisma.permissionEntry.create({
      data: { nodeId: a.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const trashed = await service.trash(actorId, a.id);
    expect(
      (await authorization.resolveCapabilities(actorId, a.id)).capabilities,
    ).toEqual(new Set());
    expect(
      (
        await authorization.resolveTrashCapabilities(actorId, a.id)
      ).capabilities.has(DocumentCapability.DELETE),
    ).toBe(true);

    const restored = await service.restore(actorId, trashed.operation.id);
    expect(restored).toMatchObject({
      operation: {
        id: trashed.operation.id,
        rootNodeId: a.id,
        status: TrashOperationStatus.RESTORED,
      },
      restoredNodeCount: 4,
    });
    expect(restored.operation.restoredAt).toBeInstanceOf(Date);
    const restoredNodes = await prisma.node.findMany({
      where: { id: { in: [a.id, b.id, c.id, d.id] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        parentId: true,
        trashOperationId: true,
        updatedById: true,
      },
    });
    expect(restoredNodes).toEqual(
      expect.arrayContaining([
        {
          id: a.id,
          parentId: null,
          trashOperationId: null,
          updatedById: actorId,
        },
        {
          id: b.id,
          parentId: a.id,
          trashOperationId: null,
          updatedById: actorId,
        },
        {
          id: c.id,
          parentId: a.id,
          trashOperationId: null,
          updatedById: actorId,
        },
        {
          id: d.id,
          parentId: c.id,
          trashOperationId: null,
          updatedById: actorId,
        },
      ]),
    );
    expect(
      (await authorization.resolveCapabilities(actorId, a.id)).capabilities.has(
        DocumentCapability.DELETE,
      ),
    ).toBe(true);
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'NODE_RESTORED', resourceId: a.id, actorId },
      }),
    ).resolves.toMatchObject({
      metadata: expect.objectContaining({
        trashOperationId: trashed.operation.id,
        restoredNodeCount: 4,
      }),
    });
  });

  it('restores exactly the newer operation and leaves a nested older operation trashed', async () => {
    const a = await node(null, 'restore-new-a'),
      b = await node(a.id, 'restore-new-b'),
      c = await node(b.id, 'restore-old-c');
    await prisma.permissionEntry.create({
      data: { nodeId: a.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const old = await service.trash(actorId, c.id);
    const newer = await service.trash(actorId, a.id);
    await expect(
      service.restore(actorId, newer.operation.id),
    ).resolves.toMatchObject({ restoredNodeCount: 2 });
    expect(
      (await prisma.node.findUniqueOrThrow({ where: { id: a.id } }))
        .trashOperationId,
    ).toBeNull();
    expect(
      (await prisma.node.findUniqueOrThrow({ where: { id: b.id } }))
        .trashOperationId,
    ).toBeNull();
    expect(
      (await prisma.node.findUniqueOrThrow({ where: { id: c.id } }))
        .trashOperationId,
    ).toBe(old.operation.id);
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: old.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.ACTIVE, restoredAt: null });
    expect(
      (await authorization.resolveCapabilities(actorId, c.id)).capabilities,
    ).toEqual(new Set());
  });

  it('rejects a restore name collision atomically', async () => {
    const original = await node(null, 'restore-conflict');
    await prisma.permissionEntry.create({
      data: { nodeId: original.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const trashed = await service.trash(actorId, original.id);
    const replacement = await prisma.node.create({
      data: {
        type: NodeType.FILE,
        name: original.name,
        normalizedName: original.normalizedName,
        createdById: actorId,
      },
    });
    nodeIds.push(replacement.id);
    await expect(
      service.restore(actorId, trashed.operation.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.node.findUniqueOrThrow({ where: { id: original.id } }),
    ).toMatchObject({ trashOperationId: trashed.operation.id });
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: trashed.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.ACTIVE, restoredAt: null });
    await expect(
      prisma.auditLog.findFirst({
        where: { action: 'NODE_RESTORED', resourceId: original.id },
      }),
    ).resolves.toBeNull();
    await prisma.node.delete({ where: { id: replacement.id } });
    nodeIds.splice(nodeIds.indexOf(replacement.id), 1);
  });

  it('rejects restore when the original parent is trashed', async () => {
    const parent = await node(null, 'restore-parent'),
      child = await node(parent.id, 'restore-child');
    await prisma.permissionEntry.create({
      data: { nodeId: parent.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const childOperation = await service.trash(actorId, child.id);
    await service.trash(actorId, parent.id);
    await expect(
      service.restore(actorId, childOperation.operation.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.node.findUniqueOrThrow({ where: { id: child.id } }),
    ).toMatchObject({
      parentId: parent.id,
      trashOperationId: childOperation.operation.id,
    });
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: childOperation.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.ACTIVE, restoredAt: null });
  });

  it('rejects restore when an otherwise active original parent has a trashed ancestor', async () => {
    const ancestor = await node(null, 'restore-hidden-ancestor');
    const parent = await node(ancestor.id, 'restore-hidden-parent');
    const child = await node(parent.id, 'restore-hidden-child');
    await prisma.permissionEntry.create({
      data: { nodeId: child.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const expiresAt = new Date(Date.now() + 60_000);
    const ancestorOperation = await prisma.trashOperation.create({
      data: { rootNodeId: ancestor.id, expiresAt, trashedById: actorId },
    });
    const childOperation = await prisma.trashOperation.create({
      data: {
        rootNodeId: child.id,
        originalParentId: parent.id,
        expiresAt,
        trashedById: actorId,
      },
    });
    await prisma.node.update({
      where: { id: ancestor.id },
      data: { trashOperationId: ancestorOperation.id },
    });
    await prisma.node.update({
      where: { id: child.id },
      data: { trashOperationId: childOperation.id },
    });

    await expect(
      service.restore(actorId, childOperation.id),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await prisma.node.findUniqueOrThrow({ where: { id: child.id } }),
    ).toMatchObject({
      trashOperationId: childOperation.id,
    });
  });

  it('enforces invisible, viewer, editor, administrator, and group-inherited ACLs', async () => {
    const invisible = await node(null, 'restore-invisible');
    await prisma.permissionEntry.create({
      data: { nodeId: invisible.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const invisibleOperation = await service.trash(actorId, invisible.id);
    await expect(
      service.restore(invisibleId, invisibleOperation.operation.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.restore(adminId, invisibleOperation.operation.id),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.permissionEntry.create({
      data: {
        nodeId: invisible.id,
        userId: viewerId,
        role: DocumentRole.VIEWER,
      },
    });
    await expect(
      service.restore(viewerId, invisibleOperation.operation.id),
    ).rejects.toMatchObject({ status: 403 });
    await prisma.permissionEntry.create({
      data: {
        nodeId: invisible.id,
        userId: editorId,
        role: DocumentRole.EDITOR,
      },
    });
    await expect(
      service.restore(editorId, invisibleOperation.operation.id),
    ).resolves.toMatchObject({ restoredNodeCount: 1 });

    const parent = await node(null, 'restore-group-parent'),
      child = await node(parent.id, 'restore-group-child');
    await prisma.permissionEntry.create({
      data: { nodeId: parent.id, groupId, role: DocumentRole.OWNER },
    });
    const groupOperation = await service.trash(actorId, child.id);
    await expect(
      service.restore(actorId, groupOperation.operation.id),
    ).resolves.toMatchObject({ restoredNodeCount: 1 });
  });

  it('does not authorize the trashed-by user after its ACL is removed', async () => {
    const root = await node(null, 'restore-no-trashed-by-bypass');
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: root.id, userId: actorId },
    });
    await expect(
      service.restore(actorId, operation.operation.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('allows exactly one concurrent restore and rejects repeated or non-active status restores', async () => {
    const root = await node(null, 'restore-concurrent');
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    const results = await Promise.allSettled([
      service.restore(actorId, operation.operation.id),
      service.restore(actorId, operation.operation.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      service.restore(actorId, operation.operation.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.auditLog.count({
        where: { action: 'NODE_RESTORED', resourceId: root.id },
      }),
    ).toBe(1);

    for (const status of [
      TrashOperationStatus.PURGING,
      TrashOperationStatus.PURGED,
    ]) {
      await prisma.trashOperation.update({
        where: { id: operation.operation.id },
        data: { status },
      });
      await expect(
        service.restore(actorId, operation.operation.id),
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it('purges a file and all versions only after deleting every storage object', async () => {
    storage.delete.mockClear();
    const root = await node(null, 'purge-file', NodeType.FILE);
    const fixture = await file(root.id);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const shareLink = await prisma.shareLink.create({
      data: {
        nodeId: root.id,
        tokenHash: `purge-share-${randomUUID()}`,
        createdById: actorId,
      },
    });
    await prisma.favorite.create({
      data: { userId: actorId, nodeId: root.id },
    });
    await prisma.recentItem.create({
      data: { userId: actorId, nodeId: root.id },
    });
    await prisma.fileProcessingTask.create({
      data: {
        fileVersionId: fixture.versions[0].id,
        type: FileProcessingTaskType.VALIDATION,
      },
    });
    await prisma.searchDocument.create({
      data: {
        fileId: fixture.id,
        fileVersionId: fixture.versions[1].id,
        contentText: 'purge fixture',
      },
    });
    await prisma.editorSession.create({
      data: {
        fileId: fixture.id,
        baseVersionId: fixture.versions[1].id,
        documentKey: `purge-session-${randomUUID()}`,
        actorType: EditorActorType.USER,
        userId: actorId,
        shareLinkId: null,
        mode: EditorMode.VIEW,
      },
    });
    const operation = await service.trash(actorId, root.id);

    await expect(
      service.purge(actorId, operation.operation.id),
    ).resolves.toMatchObject({
      operationId: operation.operation.id,
      rootNodeId: root.id,
      status: TrashOperationStatus.PURGED,
      purgedNodeCount: 1,
      purgedFileCount: 1,
      purgedVersionCount: 2,
    });
    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(await prisma.node.findUnique({ where: { id: root.id } })).toBeNull();
    expect(
      await prisma.file.findUnique({ where: { id: fixture.id } }),
    ).toBeNull();
    expect(
      await prisma.fileVersion.count({ where: { fileId: fixture.id } }),
    ).toBe(0);
    await expect(
      prisma.permissionEntry.findFirst({ where: { nodeId: root.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.shareLink.findUnique({ where: { id: shareLink.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.favorite.findUnique({
        where: { userId_nodeId: { userId: actorId, nodeId: root.id } },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.recentItem.findUnique({
        where: { userId_nodeId: { userId: actorId, nodeId: root.id } },
      }),
    ).resolves.toBeNull();
    expect(
      await prisma.fileProcessingTask.count({
        where: {
          fileVersionId: { in: fixture.versions.map((version) => version.id) },
        },
      }),
    ).toBe(0);
    await expect(
      prisma.searchDocument.findUnique({ where: { fileId: fixture.id } }),
    ).resolves.toBeNull();
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: operation.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.PURGED });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'NODE_PURGED', resourceId: root.id, actorId },
      }),
    ).resolves.toBeTruthy();
  });

  it('purges an entire subtree, preserving an unrelated sibling and nested operation history', async () => {
    storage.delete.mockClear();
    const parent = await node(null, 'purge-parent');
    const left = await node(parent.id, 'purge-left', NodeType.FILE);
    const branch = await node(parent.id, 'purge-branch');
    const nested = await node(branch.id, 'purge-nested', NodeType.FILE);
    const sibling = await node(null, 'purge-sibling', NodeType.FILE);
    const leftFile = await file(left.id);
    const nestedFile = await file(nested.id);
    const siblingFile = await file(sibling.id);
    await prisma.permissionEntry.create({
      data: { nodeId: parent.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const old = await service.trash(actorId, nested.id);
    const newer = await service.trash(actorId, parent.id);

    await expect(
      service.purge(actorId, newer.operation.id),
    ).resolves.toMatchObject({
      purgedNodeCount: 4,
      purgedFileCount: 2,
      purgedVersionCount: 4,
    });
    expect(
      await prisma.node.count({
        where: { id: { in: [parent.id, left.id, branch.id, nested.id] } },
      }),
    ).toBe(0);
    expect(
      await prisma.file.findUnique({ where: { id: leftFile.id } }),
    ).toBeNull();
    expect(
      await prisma.file.findUnique({ where: { id: nestedFile.id } }),
    ).toBeNull();
    expect(
      await prisma.node.findUnique({ where: { id: sibling.id } }),
    ).not.toBeNull();
    expect(
      await prisma.file.findUnique({ where: { id: siblingFile.id } }),
    ).not.toBeNull();
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: old.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.PURGED });
  });

  it('leaves metadata PURGING when storage deletion fails and completes on an authorized retry', async () => {
    const root = await node(null, 'purge-storage-failure', NodeType.FILE);
    const fixture = await file(root.id);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    storage.delete
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('controlled storage failure'));

    await expect(
      service.purge(actorId, operation.operation.id),
    ).rejects.toMatchObject({
      status: 503,
    });
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: operation.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.PURGING, purgedAt: null });
    expect(
      await prisma.node.findUnique({ where: { id: root.id } }),
    ).not.toBeNull();
    expect(
      await prisma.file.findUnique({ where: { id: fixture.id } }),
    ).not.toBeNull();
    expect(
      await prisma.auditLog.findFirst({
        where: { action: 'NODE_PURGED', resourceId: root.id },
      }),
    ).toBeNull();

    storage.delete.mockReset().mockResolvedValue(undefined);
    await expect(
      service.purge(actorId, operation.operation.id),
    ).resolves.toMatchObject({
      status: TrashOperationStatus.PURGED,
    });
  });

  it('does not authorize invisible, viewer, or ACL-less administrator purges or touch storage', async () => {
    const root = await node(null, 'purge-authorization', NodeType.FILE);
    await file(root.id, 1);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    storage.delete.mockClear();
    await expect(
      service.purge(invisibleId, operation.operation.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.purge(adminId, operation.operation.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: viewerId, role: DocumentRole.VIEWER },
    });
    await expect(
      service.purge(viewerId, operation.operation.id),
    ).rejects.toMatchObject({
      status: 403,
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: operation.operation.id },
      }),
    ).toMatchObject({ status: TrashOperationStatus.ACTIVE });

    const trashedByRoot = await node(
      null,
      'purge-no-trashed-by-bypass',
      NodeType.FILE,
    );
    await file(trashedByRoot.id, 1);
    await prisma.permissionEntry.create({
      data: {
        nodeId: trashedByRoot.id,
        userId: actorId,
        role: DocumentRole.OWNER,
      },
    });
    const trashedByOperation = await service.trash(actorId, trashedByRoot.id);
    await prisma.permissionEntry.deleteMany({
      where: { nodeId: trashedByRoot.id, userId: actorId },
    });
    storage.delete.mockClear();
    await expect(
      service.purge(actorId, trashedByOperation.operation.id),
    ).rejects.toMatchObject({ status: 404 });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('serializes concurrent restore and purge into one coherent lifecycle outcome', async () => {
    storage.delete.mockReset().mockResolvedValue(undefined);
    const root = await node(null, 'purge-race', NodeType.FILE);
    await file(root.id, 1);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    const results = await Promise.allSettled([
      service.restore(actorId, operation.operation.id),
      service.purge(actorId, operation.operation.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const status = (
      await prisma.trashOperation.findUniqueOrThrow({
        where: { id: operation.operation.id },
      })
    ).status;
    expect([
      TrashOperationStatus.RESTORED,
      TrashOperationStatus.PURGED,
    ]).toContain(status);
    if (status === TrashOperationStatus.RESTORED) {
      expect(
        await prisma.node.findUnique({ where: { id: root.id } }),
      ).not.toBeNull();
    } else {
      expect(
        await prisma.node.findUnique({ where: { id: root.id } }),
      ).toBeNull();
    }
  });

  it('rejects purge for restored operations and allows only one concurrent structural finalization', async () => {
    storage.delete.mockReset().mockResolvedValue(undefined);
    const restoredRoot = await node(null, 'purge-restored', NodeType.FILE);
    await file(restoredRoot.id, 1);
    await prisma.permissionEntry.create({
      data: {
        nodeId: restoredRoot.id,
        userId: actorId,
        role: DocumentRole.OWNER,
      },
    });
    const restoredOperation = await service.trash(actorId, restoredRoot.id);
    await service.restore(actorId, restoredOperation.operation.id);
    await expect(
      service.purge(actorId, restoredOperation.operation.id),
    ).rejects.toMatchObject({ status: 409 });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(
      await prisma.node.findUnique({ where: { id: restoredRoot.id } }),
    ).not.toBeNull();

    const root = await node(null, 'purge-double', NodeType.FILE);
    await file(root.id, 1);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
    });
    const operation = await service.trash(actorId, root.id);
    const results = await Promise.allSettled([
      service.purge(actorId, operation.operation.id),
      service.purge(actorId, operation.operation.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.auditLog.count({
        where: { action: 'NODE_PURGED', resourceId: root.id },
      }),
    ).toBe(1);
  });
});
