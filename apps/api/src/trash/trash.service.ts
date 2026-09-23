import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  NodeType,
  Prisma,
  TrashOperationStatus,
  type PrismaClient,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import type { StorageService } from '@dochub/storage';
import { TRASH_CONFIG, type TrashConfig } from './trash.config.js';

type TrashClient = PrismaClient | Prisma.TransactionClient;

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
  nestedOperationIds: string[];
}

@Injectable()
export class TrashService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @Inject(TRASH_CONFIG) private readonly config: TrashConfig,
  ) {}
  async trash(actorId: string, nodeId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.trashOnce(actorId, nodeId);
      } catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error))
          throw new ConflictException('Trash operation conflicted; retry');
        throw error;
      }
    }
    throw new ConflictException('Trash operation conflicted; retry');
  }
  private async trashOnce(actorId: string, nodeId: string) {
    return this.database.prisma.$transaction(
      async (tx) => {
        const root = await tx.node.findFirst({
          where: { id: nodeId, trashOperationId: null },
          select: { id: true, parentId: true },
        });
        if (!root) throw new NotFoundException('Node not found');
        const resolved = await this.authorization.resolveCapabilities(
          actorId,
          nodeId,
          tx,
        );
        if (!resolved.capabilities.has(DocumentCapability.VIEW))
          throw new NotFoundException('Node not found');
        if (!resolved.capabilities.has(DocumentCapability.DELETE))
          throw new ForbiddenException(
            'You do not have the required document capability',
          );
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + this.config.retentionDays * 86_400_000,
        );
        const operation = await tx.trashOperation.create({
          data: {
            rootNodeId: root.id,
            originalParentId: root.parentId,
            trashedById: actorId,
            status: TrashOperationStatus.ACTIVE,
            trashedAt: now,
            expiresAt,
          },
        });
        const rows = await tx.$queryRaw<
          Array<{ id: string }>
        >`WITH RECURSIVE tree AS (SELECT "id", "parentId" FROM "Node" WHERE "id" = ${nodeId}::uuid UNION ALL SELECT child."id", child."parentId" FROM "Node" AS child JOIN tree ON child."parentId" = tree."id") SELECT "id" FROM tree`;
        const updated = await tx.node.updateMany({
          where: {
            id: { in: rows.map((row) => row.id) },
            trashOperationId: null,
          },
          data: { trashOperationId: operation.id, updatedById: actorId },
        });
        await tx.auditLog.create({
          data: {
            actorType: AuditActorType.USER,
            actorId,
            action: 'NODE_TRASHED',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: AuditResult.SUCCESS,
            metadata: {
              trashOperationId: operation.id,
              originalParentId: root.parentId,
              affectedNodeCount: updated.count,
              expiresAt: expiresAt.toISOString(),
            },
          },
        });
        return {
          operation: {
            id: operation.id,
            rootNodeId: root.id,
            status: operation.status,
            trashedAt: operation.trashedAt,
            expiresAt: operation.expiresAt,
          },
          affectedNodeCount: updated.count,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  async restore(actorId: string, operationId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT "id" FROM "TrashOperation" WHERE "id" = ${operationId}::uuid FOR UPDATE`;
            if (!locked[0])
              throw new NotFoundException('Trash operation not found');
            const operation = await tx.trashOperation.findUnique({
              where: { id: operationId },
              include: { rootNode: true },
            });
            if (!operation?.rootNode || !operation.rootNodeId)
              throw new ConflictException('Trash operation is unavailable');
            const capabilities =
              await this.authorization.resolveTrashCapabilities(
                actorId,
                operation.rootNodeId,
                tx,
              );
            if (!capabilities.capabilities.has(DocumentCapability.VIEW))
              throw new NotFoundException('Node not found');
            if (!capabilities.capabilities.has(DocumentCapability.DELETE))
              throw new ForbiddenException(
                'You do not have the required document capability',
              );
            if (operation.status !== TrashOperationStatus.ACTIVE)
              throw new ConflictException('Trash operation cannot be restored');
            if (
              operation.rootNode.trashOperationId !== operationId ||
              operation.rootNode.parentId !== operation.originalParentId
            )
              throw new ConflictException('Trash operation is inconsistent');
            if (
              operation.originalParentId &&
              !(await this.isOriginalParentAvailable(
                tx,
                operation.originalParentId,
              ))
            ) {
              throw new ConflictException('Original parent is unavailable');
            }
            const clash = await tx.node.findFirst({
              where: {
                parentId: operation.originalParentId,
                normalizedName: operation.rootNode.normalizedName,
                trashOperationId: null,
              },
            });
            if (clash)
              throw new ConflictException(
                'A node with this name already exists',
              );
            const restored = await tx.node.updateMany({
              where: { trashOperationId: operationId },
              data: { trashOperationId: null, updatedById: actorId },
            });
            const now = new Date();
            const updated = await tx.trashOperation.update({
              where: { id: operationId },
              data: { status: TrashOperationStatus.RESTORED, restoredAt: now },
            });
            await tx.auditLog.create({
              data: {
                actorType: AuditActorType.USER,
                actorId,
                action: 'NODE_RESTORED',
                resourceType: 'NODE',
                resourceId: operation.rootNodeId,
                result: AuditResult.SUCCESS,
                metadata: {
                  trashOperationId: operationId,
                  originalParentId: operation.originalParentId,
                  restoredNodeCount: restored.count,
                },
              },
            });
            return {
              operation: {
                id: updated.id,
                rootNodeId: updated.rootNodeId,
                status: updated.status,
                restoredAt: updated.restoredAt,
              },
              restoredNodeCount: restored.count,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error))
          throw new ConflictException('Restore conflicted; retry');
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'P2002'
        )
          throw new ConflictException('A node with this name already exists');
        throw error;
      }
    }
    throw new ConflictException('Restore conflicted; retry');
  }

  async purge(actorId: string, operationId: string) {
    const claim = await this.claimPurge(actorId, operationId);
    const plan = await this.discoverSubtree(
      this.database.prisma,
      claim.rootNodeId,
    );

    try {
      await this.deleteStorageObjects(plan.storageKeys);
    } catch {
      throw new ServiceUnavailableException(
        'Document storage is temporarily unavailable',
      );
    }

    return this.finalizePurge(actorId, operationId, claim.rootNodeId);
  }

  private async claimPurge(actorId: string, operationId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT "id" FROM "TrashOperation" WHERE "id" = ${operationId}::uuid FOR UPDATE`;
            if (!locked[0])
              throw new NotFoundException('Trash operation not found');
            const operation = await tx.trashOperation.findUnique({
              where: { id: operationId },
              include: { rootNode: true },
            });
            if (!operation?.rootNode || !operation.rootNodeId)
              throw new ConflictException('Trash operation is unavailable');
            const capabilities =
              await this.authorization.resolveTrashCapabilities(
                actorId,
                operation.rootNodeId,
                tx,
              );
            if (!capabilities.capabilities.has(DocumentCapability.VIEW))
              throw new NotFoundException('Node not found');
            if (!capabilities.capabilities.has(DocumentCapability.DELETE))
              throw new ForbiddenException(
                'You do not have the required document capability',
              );
            if (
              operation.status !== TrashOperationStatus.ACTIVE &&
              operation.status !== TrashOperationStatus.PURGING
            )
              throw new ConflictException('Trash operation cannot be purged');
            if (operation.rootNode.trashOperationId !== operationId)
              throw new ConflictException('Trash operation is inconsistent');
            if (operation.status === TrashOperationStatus.ACTIVE) {
              await tx.trashOperation.update({
                where: { id: operationId },
                data: { status: TrashOperationStatus.PURGING },
              });
            }
            return { rootNodeId: operation.rootNodeId };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error))
          throw new ConflictException('Purge conflicted; retry');
        throw error;
      }
    }
    throw new ConflictException('Purge conflicted; retry');
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

  private async finalizePurge(
    actorId: string,
    operationId: string,
    rootNodeId: string,
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(
          async (tx) => {
            const locked = await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT "id" FROM "TrashOperation" WHERE "id" = ${operationId}::uuid FOR UPDATE`;
            if (!locked[0])
              throw new ConflictException('Trash operation is unavailable');
            const operation = await tx.trashOperation.findUnique({
              where: { id: operationId },
              include: { rootNode: true },
            });
            if (
              !operation?.rootNode ||
              operation.rootNodeId !== rootNodeId ||
              operation.rootNode.trashOperationId !== operationId
            )
              throw new ConflictException('Trash operation is inconsistent');
            if (operation.status !== TrashOperationStatus.PURGING)
              throw new ConflictException('Trash operation cannot be purged');

            const plan = await this.discoverSubtree(tx, rootNodeId);
            const nestedOperations = await tx.trashOperation.findMany({
              where: { rootNodeId: { in: plan.nodeIds } },
              select: { id: true, status: true },
            });
            const fileIds = plan.fileIds;
            const versionIds = plan.versionIds;

            await tx.editorSession.deleteMany({
              where: {
                OR: [
                  ...(fileIds.length > 0 ? [{ fileId: { in: fileIds } }] : []),
                  ...(plan.nodeIds.length > 0
                    ? [{ shareLink: { nodeId: { in: plan.nodeIds } } }]
                    : []),
                ],
              },
            });
            await tx.shareLink.deleteMany({
              where: { nodeId: { in: plan.nodeIds } },
            });
            await tx.permissionEntry.deleteMany({
              where: { nodeId: { in: plan.nodeIds } },
            });
            if (fileIds.length > 0) {
              await tx.file.updateMany({
                where: { id: { in: fileIds } },
                data: { currentVersionId: null },
              });
              await tx.fileVersion.deleteMany({
                where: { id: { in: versionIds } },
              });
              await tx.file.deleteMany({ where: { id: { in: fileIds } } });
            }
            for (const nodeId of plan.nodesByDeepestFirst) {
              await tx.node.delete({ where: { id: nodeId } });
            }

            const now = new Date();
            const operationIds = nestedOperations
              .filter(
                (nested) =>
                  nested.status === TrashOperationStatus.ACTIVE ||
                  nested.status === TrashOperationStatus.PURGING,
              )
              .map((nested) => nested.id);
            await tx.trashOperation.updateMany({
              where: { id: { in: operationIds } },
              data: { status: TrashOperationStatus.PURGED, purgedAt: now },
            });
            await tx.auditLog.create({
              data: {
                actorType: AuditActorType.USER,
                actorId,
                action: 'NODE_PURGED',
                resourceType: 'NODE',
                resourceId: rootNodeId,
                result: AuditResult.SUCCESS,
                metadata: {
                  trashOperationId: operationId,
                  purgedNodeCount: plan.nodeIds.length,
                  purgedFileCount: fileIds.length,
                  purgedVersionCount: versionIds.length,
                  deletedBytes: plan.deletedBytes.toString(),
                  nestedTrashOperationCount: operationIds.length,
                },
              },
            });
            return {
              operationId,
              rootNodeId,
              status: TrashOperationStatus.PURGED,
              purgedAt: now,
              purgedNodeCount: plan.nodeIds.length,
              purgedFileCount: fileIds.length,
              purgedVersionCount: versionIds.length,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error))
          throw new ConflictException('Purge conflicted; retry');
        throw error;
      }
    }
    throw new ConflictException('Purge conflicted; retry');
  }

  private async discoverSubtree(
    client: TrashClient,
    rootNodeId: string,
  ): Promise<PurgePlan> {
    const nodes = await client.$queryRaw<
      SubtreeNodeRow[]
    >`WITH RECURSIVE tree AS (
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
    if (nodes.length === 0)
      throw new ConflictException('Trash operation is inconsistent');

    const nodeIds = nodes.map((node) => node.id);
    const files = await client.file.findMany({
      where: { nodeId: { in: nodeIds } },
      select: {
        id: true,
        versions: {
          select: { id: true, storageKey: true, sizeBytes: true },
        },
      },
    });
    const versions = files.flatMap((file) => file.versions);
    const nestedOperations = await client.trashOperation.findMany({
      where: { rootNodeId: { in: nodeIds } },
      select: { id: true },
    });

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
      nestedOperationIds: nestedOperations.map((operation) => operation.id),
    };
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

  private async isOriginalParentAvailable(
    client: Prisma.TransactionClient | PrismaClient,
    parentId: string,
  ): Promise<boolean> {
    const ancestors = await client.$queryRaw<
      Array<{ id: string; type: NodeType; trashOperationId: string | null }>
    >`WITH RECURSIVE ancestor_chain AS (
        SELECT
          "id",
          "parentId",
          "type",
          "trashOperationId",
          ARRAY["id"] AS path
        FROM "Node"
        WHERE "id" = ${parentId}::uuid

        UNION ALL

        SELECT
          parent."id",
          parent."parentId",
          parent."type",
          parent."trashOperationId",
          child.path || parent."id"
        FROM "Node" AS parent
        INNER JOIN ancestor_chain AS child ON parent."id" = child."parentId"
        WHERE NOT parent."id" = ANY(child.path)
      )
      SELECT "id", "type", "trashOperationId"
      FROM ancestor_chain`;

    return (
      ancestors.length > 0 &&
      ancestors[0].type === NodeType.FOLDER &&
      ancestors.every((ancestor) => ancestor.trashOperationId === null)
    );
  }
}
