import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AuditActorType,
  DocumentRole,
  NodeType,
  TrashOperationStatus,
  UserStatus,
  prisma,
} from '@dochub/database';
import { PurgeError, TrashPurgeEngine } from '@dochub/trash';

async function createFixture() {
  const actorId = randomUUID();
  const nodeIds = [];
  await prisma.user.create({
    data: {
      id: actorId,
      email: `purge-engine-${actorId}@example.test`,
      normalizedEmail: `purge-engine-${actorId}@example.test`,
      displayName: 'Purge engine fixture',
      status: UserStatus.ACTIVE,
    },
  });
  const node = async (parentId, type = NodeType.FILE) => {
    const id = randomUUID();
    nodeIds.push(id);
    return prisma.node.create({
      data: {
        id,
        parentId,
        type,
        name: `node-${id}`,
        normalizedName: `node-${id}`,
        createdById: actorId,
      },
    });
  };
  const file = async (nodeId, versionCount = 1) => {
    const id = randomUUID();
    await prisma.file.create({
      data: { id, nodeId, versionCounter: versionCount },
    });
    const versions = [];
    for (let index = 0; index < versionCount; index += 1) {
      const versionId = randomUUID();
      versions.push(
        await prisma.fileVersion.create({
          data: {
            id: versionId,
            fileId: id,
            versionNumber: index + 1,
            storageKey: `engine/${id}/${versionId}`,
            originalFilename: 'engine.pdf',
            mimeType: 'application/pdf',
            extension: 'pdf',
            sizeBytes: BigInt(index + 1),
            sha256: String(index + 1).repeat(64),
            source: 'UPLOAD',
            createdById: actorId,
          },
        }),
      );
    }
    await prisma.file.update({
      where: { id },
      data: { currentVersionId: versions.at(-1).id },
    });
    return { id, versions };
  };
  const operation = async (rootNodeId, nodes) => {
    const record = await prisma.trashOperation.create({
      data: { rootNodeId, trashedById: actorId, expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.node.updateMany({
      where: { id: { in: nodes } },
      data: { trashOperationId: record.id },
    });
    return record;
  };
  const cleanup = async () => {
    await prisma.auditLog.deleteMany({ where: { actorId } });
    const nodes = await prisma.node.findMany({
      where: { createdById: actorId },
      select: { id: true },
    });
    const ids = nodes.map((record) => record.id);
    await prisma.node.updateMany({
      where: { id: { in: ids } },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.deleteMany({ where: { trashedById: actorId } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    await prisma.shareLink.deleteMany({ where: { nodeId: { in: ids } } });
    const files = await prisma.file.findMany({
      where: { nodeId: { in: ids } },
      select: { id: true },
    });
    await prisma.file.updateMany({
      where: { id: { in: files.map((record) => record.id) } },
      data: { currentVersionId: null },
    });
    await prisma.fileVersion.deleteMany({
      where: { fileId: { in: files.map((record) => record.id) } },
    });
    await prisma.file.deleteMany({ where: { id: { in: files.map((record) => record.id) } } });
    for (const record of [...nodes].reverse()) {
      await prisma.node.deleteMany({ where: { id: record.id } });
    }
    await prisma.user.delete({ where: { id: actorId } });
  };
  return { actorId, node, file, operation, cleanup };
}

test('purges a nested subtree after storage deletion and preserves unrelated records', async () => {
  const fixture = await createFixture();
  try {
    const root = await fixture.node(null, NodeType.FOLDER);
    const child = await fixture.node(root.id);
    const nested = await fixture.node(child.id);
    const sibling = await fixture.node(null);
    const childFile = await fixture.file(child.id, 2);
    const nestedFile = await fixture.file(nested.id);
    const siblingFile = await fixture.file(sibling.id);
    await prisma.permissionEntry.create({
      data: { nodeId: root.id, userId: fixture.actorId, role: DocumentRole.OWNER },
    });
    const share = await prisma.shareLink.create({
      data: { nodeId: child.id, tokenHash: `engine-share-${randomUUID()}` },
    });
    const old = await fixture.operation(nested.id, [nested.id]);
    const newer = await fixture.operation(root.id, [root.id, child.id]);
    const deleted = [];
    const storage = {
      async delete(key) {
        assert.ok(
          await prisma.fileVersion.count({
            where: { fileId: { in: [childFile.id, nestedFile.id] } },
          }),
        );
        deleted.push(key);
      },
    };
    const engine = new TrashPurgeEngine(prisma, storage);
    const result = await engine.purge({
      operationId: newer.id,
      actor: { actorType: AuditActorType.USER, actorId: fixture.actorId },
      authorize: async () => 'allowed',
    });
    assert.equal(result.status, TrashOperationStatus.PURGED);
    assert.equal(result.purgedNodeCount, 3);
    assert.equal(result.purgedVersionCount, 3);
    assert.equal(deleted.length, 3);
    assert.equal(await prisma.node.count({ where: { id: { in: [root.id, child.id, nested.id] } } }), 0);
    assert.ok(await prisma.node.findUnique({ where: { id: sibling.id } }));
    assert.ok(await prisma.file.findUnique({ where: { id: siblingFile.id } }));
    assert.equal(await prisma.shareLink.findUnique({ where: { id: share.id } }), null);
    assert.equal((await prisma.trashOperation.findUniqueOrThrow({ where: { id: old.id } })).status, TrashOperationStatus.PURGED);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'NODE_PURGED', resourceId: root.id },
    });
    assert.equal(audit.actorId, fixture.actorId);
    assert.equal(audit.actorType, AuditActorType.USER);
  } finally {
    await fixture.cleanup();
  }
});

test('keeps metadata PURGING after a storage failure and finalizes on retry', async () => {
  const fixture = await createFixture();
  try {
    const root = await fixture.node(null);
    const file = await fixture.file(root.id, 2);
    const operation = await fixture.operation(root.id, [root.id]);
    let attempts = 0;
    const failing = new TrashPurgeEngine(prisma, {
      async delete() {
        attempts += 1;
        if (attempts === 2) throw new Error('controlled failure');
      },
    });
    await assert.rejects(
      failing.purge({
        operationId: operation.id,
        actor: { actorType: AuditActorType.USER, actorId: fixture.actorId },
        authorize: async () => 'allowed',
      }),
      (error) => error instanceof PurgeError && error.code === 'STORAGE_FAILURE',
    );
    assert.equal((await prisma.trashOperation.findUniqueOrThrow({ where: { id: operation.id } })).status, TrashOperationStatus.PURGING);
    assert.ok(await prisma.file.findUnique({ where: { id: file.id } }));
    const retry = new TrashPurgeEngine(prisma, { async delete() {} });
    await retry.purge({
      operationId: operation.id,
      actor: { actorType: AuditActorType.USER, actorId: fixture.actorId },
      authorize: async () => 'allowed',
    });
    assert.equal(await prisma.node.findUnique({ where: { id: root.id } }), null);
  } finally {
    await fixture.cleanup();
  }
});
