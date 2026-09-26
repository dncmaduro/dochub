import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { PrismaClient, type TrashOperationStatus } from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';

/** All mutations and candidate queries are scoped to this fixture's user/IDs. */
export async function createRetentionFixture() {
  if (!process.env.DATABASE_URL)
    throw new Error('DATABASE_URL is required for retention integration tests');
  const database = new PrismaClient();
  const actorId = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'dochub-retention-'));
  const storage = new LocalFileStorage(root);
  const nodeIds: string[] = [];
  const operationIds: string[] = [];
  await database.user.create({
    data: {
      id: actorId,
      email: `${actorId}@retention.test`,
      normalizedEmail: `${actorId}@retention.test`,
      displayName: 'Retention fixture',
      status: 'ACTIVE',
    },
  });
  const scoped = database.$extends({
    query: {
      trashOperation: {
        async findMany({ args, query }) {
          args.where = { AND: [args.where ?? {}, { trashedById: actorId }] };
          return query(args);
        },
      },
    },
  });
  async function document(
    status: TrashOperationStatus = 'ACTIVE',
    expiresAt = new Date(Date.now() - 60_000),
    id: string = randomUUID(),
  ) {
    const nodeId = randomUUID();
    nodeIds.push(nodeId);
    const node = await database.node.create({
      data: {
        id: nodeId,
        type: 'FILE',
        name: nodeId,
        normalizedName: nodeId,
        createdById: actorId,
        inheritPermissions: false,
        publicAccess: false,
      },
    });
    const file = await database.file.create({
      data: { nodeId, versionCounter: 1 },
    });
    const versionId = randomUUID();
    const storageKey = `retention/${file.id}/${versionId}`;
    await storage.putStream(
      storageKey,
      Readable.from(Buffer.from('retention fixture')),
    );
    const version = await database.fileVersion.create({
      data: {
        id: versionId,
        fileId: file.id,
        versionNumber: 1,
        storageKey,
        originalFilename: 'fixture.txt',
        mimeType: 'text/plain',
        sizeBytes: 17n,
        sha256: 'a'.repeat(64),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await database.file.update({
      where: { id: file.id },
      data: { currentVersionId: versionId },
    });
    const operation = await database.trashOperation.create({
      data: {
        id,
        rootNodeId: nodeId,
        trashedById: actorId,
        status,
        expiresAt,
      },
    });
    operationIds.push(operation.id);
    await database.node.update({
      where: { id: nodeId },
      data: { trashOperationId: operation.id },
    });
    return { node, file, version, operation, storageKey };
  }
  async function cleanup() {
    try {
      await database.auditLog.deleteMany({
        where: { resourceId: { in: nodeIds } },
      });
      await database.node.updateMany({
        where: { id: { in: nodeIds } },
        data: { trashOperationId: null },
      });
      await database.trashOperation.deleteMany({
        where: { id: { in: operationIds } },
      });
      await database.file.updateMany({
        where: { nodeId: { in: nodeIds } },
        data: { currentVersionId: null },
      });
      await database.fileVersion.deleteMany({
        where: { file: { nodeId: { in: nodeIds } } },
      });
      await database.file.deleteMany({ where: { nodeId: { in: nodeIds } } });
      await database.node.deleteMany({ where: { id: { in: nodeIds } } });
      await database.user.delete({ where: { id: actorId } });
    } finally {
      await database.$disconnect();
      await rm(root, { recursive: true, force: true });
    }
  }
  return {
    database,
    scoped: scoped as unknown as PrismaClient,
    storage,
    root,
    actorId,
    document,
    cleanup,
  };
}
