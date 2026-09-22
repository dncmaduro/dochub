import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditActorType, AuditResult, Prisma, TrashOperationStatus } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { TRASH_CONFIG, type TrashConfig } from './trash.config.js';

@Injectable()
export class TrashService {
  constructor(private readonly database: DatabaseService, private readonly authorization: DocumentAuthorizationService, @Inject(TRASH_CONFIG) private readonly config: TrashConfig) {}
  async trash(actorId: string, nodeId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await this.trashOnce(actorId, nodeId); }
      catch (error) {
        if (this.isSerializationConflict(error) && attempt < 2) continue;
        if (this.isSerializationConflict(error)) throw new ConflictException('Trash operation conflicted; retry');
        throw error;
      }
    }
    throw new ConflictException('Trash operation conflicted; retry');
  }
  private async trashOnce(actorId: string, nodeId: string) {
    return this.database.prisma.$transaction(async tx => {
        const root = await tx.node.findFirst({ where: { id: nodeId, trashOperationId: null }, select: { id: true, parentId: true } });
        if (!root) throw new NotFoundException('Node not found');
        const resolved = await this.authorization.resolveCapabilities(actorId, nodeId, tx);
        if (!resolved.capabilities.has(DocumentCapability.VIEW)) throw new NotFoundException('Node not found');
        if (!resolved.capabilities.has(DocumentCapability.DELETE)) throw new ForbiddenException('You do not have the required document capability');
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.config.retentionDays * 86_400_000);
        const operation = await tx.trashOperation.create({ data: { rootNodeId: root.id, originalParentId: root.parentId, trashedById: actorId, status: TrashOperationStatus.ACTIVE, trashedAt: now, expiresAt } });
        const rows = await tx.$queryRaw<Array<{ id: string }>>`WITH RECURSIVE tree AS (SELECT "id", "parentId" FROM "Node" WHERE "id" = ${nodeId}::uuid UNION ALL SELECT child."id", child."parentId" FROM "Node" AS child JOIN tree ON child."parentId" = tree."id") SELECT "id" FROM tree`;
        const updated = await tx.node.updateMany({ where: { id: { in: rows.map(row => row.id) }, trashOperationId: null }, data: { trashOperationId: operation.id, updatedById: actorId } });
        await tx.auditLog.create({ data: { actorType: AuditActorType.USER, actorId, action: 'NODE_TRASHED', resourceType: 'NODE', resourceId: nodeId, result: AuditResult.SUCCESS, metadata: { trashOperationId: operation.id, originalParentId: root.parentId, affectedNodeCount: updated.count, expiresAt: expiresAt.toISOString() } } });
        return { operation: { id: operation.id, rootNodeId: root.id, status: operation.status, trashedAt: operation.trashedAt, expiresAt: operation.expiresAt }, affectedNodeCount: updated.count };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) return false;
    if (error.code === 'P2034') return true;
    return error.code === 'P2010' && 'meta' in error && !!error.meta && typeof error.meta === 'object' && 'code' in error.meta && error.meta.code === '40001';
  }
}
