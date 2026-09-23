import {
  AuditResult,
  type AuditActorType,
  Prisma,
  TrashOperationStatus,
  type PrismaClient,
} from '@dochub/database';
import type { StorageService } from '@dochub/storage';

type TrashClient = PrismaClient | Prisma.TransactionClient;

export type PurgeAuthorization = 'allowed' | 'not_found' | 'forbidden';

export interface PurgeActor {
  actorType: AuditActorType;
  actorId: string | null;
}

export interface PurgeRequest {
  operationId: string;
  actor: PurgeActor;
  authorize(rootNodeId: string, client: Prisma.TransactionClient): Promise<PurgeAuthorization>;
}

export interface PurgeResult {
  operationId: string;
  rootNodeId: string;
  status: typeof TrashOperationStatus.PURGED;
  purgedAt: Date;
  purgedNodeCount: number;
  purgedFileCount: number;
  purgedVersionCount: number;
  deletedBytes: string;
}

export type PurgeErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'STORAGE_FAILURE';

export class PurgeError extends Error {
  constructor(readonly code: PurgeErrorCode) {
    super(code);
    this.name = 'PurgeError';
  }
}

interface SubtreeNodeRow {
  id: string;
  depth: number;
}

interface PurgePlan {
  nodeIds: string[];
  nodesByDeepestFirst: string[];
  fileIds: string[];
  versionIds: string[];
  storageKeys: string[];
  deletedBytes: bigint;
}

/**
 * Framework-neutral permanent-purge engine. Callers supply both the shared
 * Prisma client and a storage implementation; this class creates neither.
 */
export class TrashPurgeEngine {
  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageService,
  ) {}

  async purge(request: PurgeRequest): Promise<PurgeResult> {
    const claim = await this.claim(request);
    const plan = await this.discoverSubtree(this.database, claim.rootNodeId);
    try {
      await this.deleteStorageObjects(plan.storageKeys);
    } catch {
      throw new PurgeError('STORAGE_FAILURE');
    }
    return this.finalize(request.actor, request.operationId, claim.rootNodeId);
  }

  private async claim(request: PurgeRequest): Promise<{ rootNodeId: string }> {
    return this.withSerializationRetry(async () =>
      this.database.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "TrashOperation" WHERE "id" = ${request.operationId}::uuid FOR UPDATE`;
          if (!locked[0]) throw new PurgeError('NOT_FOUND');
          const operation = await tx.trashOperation.findUnique({
            where: { id: request.operationId },
            include: { rootNode: true },
          });
          if (!operation?.rootNode || !operation.rootNodeId)
            throw new PurgeError('CONFLICT');
          const authorization = await request.authorize(operation.rootNodeId, tx);
          if (authorization === 'not_found') throw new PurgeError('NOT_FOUND');
          if (authorization === 'forbidden') throw new PurgeError('FORBIDDEN');
          if (
            operation.status !== TrashOperationStatus.ACTIVE &&
            operation.status !== TrashOperationStatus.PURGING
          )
            throw new PurgeError('CONFLICT');
          if (operation.rootNode.trashOperationId !== request.operationId)
            throw new PurgeError('CONFLICT');
          if (operation.status === TrashOperationStatus.ACTIVE) {
            await tx.trashOperation.update({
              where: { id: request.operationId },
              data: { status: TrashOperationStatus.PURGING },
            });
          }
          return { rootNodeId: operation.rootNodeId };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async deleteStorageObjects(storageKeys: readonly string[]) {
    const queue = [...storageKeys];
    const workers = Array.from(
      { length: Math.min(4, queue.length) },
      async () => {
        while (queue.length > 0) {
          const storageKey = queue.shift();
          if (storageKey) await this.storage.delete(storageKey);
        }
      },
    );
    await Promise.all(workers);
  }

  private async finalize(
    actor: PurgeActor,
    operationId: string,
    rootNodeId: string,
  ): Promise<PurgeResult> {
    return this.withSerializationRetry(async () =>
      this.database.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "TrashOperation" WHERE "id" = ${operationId}::uuid FOR UPDATE`;
          if (!locked[0]) throw new PurgeError('CONFLICT');
          const operation = await tx.trashOperation.findUnique({
            where: { id: operationId },
            include: { rootNode: true },
          });
          if (
            !operation?.rootNode ||
            operation.rootNodeId !== rootNodeId ||
            operation.rootNode.trashOperationId !== operationId ||
            operation.status !== TrashOperationStatus.PURGING
          )
            throw new PurgeError('CONFLICT');

          const plan = await this.discoverSubtree(tx, rootNodeId);
          const nestedOperations = await tx.trashOperation.findMany({
            where: { rootNodeId: { in: plan.nodeIds } },
            select: { id: true, status: true },
          });
          await tx.editorSession.deleteMany({
            where: {
              OR: [
                ...(plan.fileIds.length > 0
                  ? [{ fileId: { in: plan.fileIds } }]
                  : []),
                { shareLink: { nodeId: { in: plan.nodeIds } } },
              ],
            },
          });
          await tx.shareLink.deleteMany({
            where: { nodeId: { in: plan.nodeIds } },
          });
          await tx.permissionEntry.deleteMany({
            where: { nodeId: { in: plan.nodeIds } },
          });
          if (plan.fileIds.length > 0) {
            await tx.file.updateMany({
              where: { id: { in: plan.fileIds } },
              data: { currentVersionId: null },
            });
            await tx.fileVersion.deleteMany({
              where: { id: { in: plan.versionIds } },
            });
            await tx.file.deleteMany({
              where: { id: { in: plan.fileIds } },
            });
          }
          for (const nodeId of plan.nodesByDeepestFirst) {
            await tx.node.delete({ where: { id: nodeId } });
          }

          const purgedAt = new Date();
          const nestedOperationIds = nestedOperations
            .filter(
              (nested) =>
                nested.status === TrashOperationStatus.ACTIVE ||
                nested.status === TrashOperationStatus.PURGING,
            )
            .map((nested) => nested.id);
          await tx.trashOperation.updateMany({
            where: { id: { in: nestedOperationIds } },
            data: { status: TrashOperationStatus.PURGED, purgedAt },
          });
          await tx.auditLog.create({
            data: {
              actorType: actor.actorType,
              actorId: actor.actorId,
              action: 'NODE_PURGED',
              resourceType: 'NODE',
              resourceId: rootNodeId,
              result: AuditResult.SUCCESS,
              metadata: {
                trashOperationId: operationId,
                purgedNodeCount: plan.nodeIds.length,
                purgedFileCount: plan.fileIds.length,
                purgedVersionCount: plan.versionIds.length,
                deletedBytes: plan.deletedBytes.toString(),
                nestedTrashOperationCount: nestedOperationIds.length,
              },
            },
          });
          return {
            operationId,
            rootNodeId,
            status: TrashOperationStatus.PURGED,
            purgedAt,
            purgedNodeCount: plan.nodeIds.length,
            purgedFileCount: plan.fileIds.length,
            purgedVersionCount: plan.versionIds.length,
            deletedBytes: plan.deletedBytes.toString(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async discoverSubtree(
    client: TrashClient,
    rootNodeId: string,
  ): Promise<PurgePlan> {
    const nodes = await client.$queryRaw<SubtreeNodeRow[]>`WITH RECURSIVE tree AS (
      SELECT "id", "parentId", 0 AS depth, ARRAY["id"] AS path
      FROM "Node"
      WHERE "id" = ${rootNodeId}::uuid
      UNION ALL
      SELECT child."id", child."parentId", tree.depth + 1, tree.path || child."id"
      FROM "Node" AS child
      INNER JOIN tree ON child."parentId" = tree."id"
      WHERE NOT child."id" = ANY(tree.path)
    )
    SELECT "id", depth
    FROM tree`;
    if (nodes.length === 0) throw new PurgeError('CONFLICT');
    const nodeIds = nodes.map((node) => node.id);
    const files = await client.file.findMany({
      where: { nodeId: { in: nodeIds } },
      select: {
        id: true,
        versions: { select: { id: true, storageKey: true, sizeBytes: true } },
      },
    });
    const versions = files.flatMap((file) => file.versions);
    return {
      nodeIds,
      nodesByDeepestFirst: [...nodes]
        .sort((left, right) => right.depth - left.depth)
        .map((node) => node.id),
      fileIds: files.map((file) => file.id),
      versionIds: versions.map((version) => version.id),
      storageKeys: versions.map((version) => version.storageKey),
      deletedBytes: versions.reduce(
        (total, version) => total + version.sizeBytes,
        0n,
      ),
    };
  }

  private async withSerializationRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error)) throw new PurgeError('CONFLICT');
        throw error;
      }
    }
    throw new PurgeError('CONFLICT');
  }

  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    if (error.code === 'P2034') return true;
    return (
      error.code === 'P2010' &&
      'meta' in error &&
      !!error.meta &&
      typeof error.meta === 'object' &&
      'code' in error.meta &&
      error.meta.code === '40001'
    );
  }
}
