var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, } from '@nestjs/common';
import { AuditActorType, AuditResult, NodeType, Prisma, TrashOperationStatus, } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import { PurgeError, TrashPurgeEngine } from '@dochub/trash';
import { TRASH_CONFIG } from './trash.config.js';
let TrashService = class TrashService {
    database;
    authorization;
    storage;
    config;
    constructor(database, authorization, storage, config) {
        this.database = database;
        this.authorization = authorization;
        this.storage = storage;
        this.config = config;
    }
    async trash(actorId, nodeId) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await this.trashOnce(actorId, nodeId);
            }
            catch (error) {
                if (this.isSerializationConflict(error) && attempt < 2)
                    continue;
                if (this.isSerializationConflict(error))
                    throw new ConflictException('Trash operation conflicted; retry');
                throw error;
            }
        }
        throw new ConflictException('Trash operation conflicted; retry');
    }
    async trashOnce(actorId, nodeId) {
        return this.database.prisma.$transaction(async (tx) => {
            const root = await tx.node.findFirst({
                where: { id: nodeId, trashOperationId: null },
                select: { id: true, parentId: true },
            });
            if (!root)
                throw new NotFoundException('Node not found');
            const resolved = await this.authorization.resolveCapabilities(actorId, nodeId, tx);
            if (!resolved.capabilities.has(DocumentCapability.VIEW))
                throw new NotFoundException('Node not found');
            if (!resolved.capabilities.has(DocumentCapability.DELETE))
                throw new ForbiddenException('You do not have the required document capability');
            const now = new Date();
            const expiresAt = new Date(now.getTime() + this.config.retentionDays * 86_400_000);
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
            const rows = await tx.$queryRaw `WITH RECURSIVE tree AS (SELECT "id", "parentId" FROM "Node" WHERE "id" = ${nodeId}::uuid UNION ALL SELECT child."id", child."parentId" FROM "Node" AS child JOIN tree ON child."parentId" = tree."id") SELECT "id" FROM tree`;
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
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    async restore(actorId, operationId) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await this.database.prisma.$transaction(async (tx) => {
                    const locked = await tx.$queryRaw `SELECT "id" FROM "TrashOperation" WHERE "id" = ${operationId}::uuid FOR UPDATE`;
                    if (!locked[0])
                        throw new NotFoundException('Trash operation not found');
                    const operation = await tx.trashOperation.findUnique({
                        where: { id: operationId },
                        include: { rootNode: true },
                    });
                    if (!operation?.rootNode || !operation.rootNodeId)
                        throw new ConflictException('Trash operation is unavailable');
                    const capabilities = await this.authorization.resolveTrashCapabilities(actorId, operation.rootNodeId, tx);
                    if (!capabilities.capabilities.has(DocumentCapability.VIEW))
                        throw new NotFoundException('Node not found');
                    if (!capabilities.capabilities.has(DocumentCapability.DELETE))
                        throw new ForbiddenException('You do not have the required document capability');
                    if (operation.status !== TrashOperationStatus.ACTIVE)
                        throw new ConflictException('Trash operation cannot be restored');
                    if (operation.rootNode.trashOperationId !== operationId ||
                        operation.rootNode.parentId !== operation.originalParentId)
                        throw new ConflictException('Trash operation is inconsistent');
                    if (operation.originalParentId &&
                        !(await this.isOriginalParentAvailable(tx, operation.originalParentId))) {
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
                        throw new ConflictException('A node with this name already exists');
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
                }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            }
            catch (error) {
                if (this.isSerializationConflict(error) && attempt < 2)
                    continue;
                if (this.isSerializationConflict(error))
                    throw new ConflictException('Restore conflicted; retry');
                if (error &&
                    typeof error === 'object' &&
                    'code' in error &&
                    error.code === 'P2002')
                    throw new ConflictException('A node with this name already exists');
                throw error;
            }
        }
        throw new ConflictException('Restore conflicted; retry');
    }
    async purge(actorId, operationId) {
        try {
            const result = await new TrashPurgeEngine(this.database.prisma, this.storage).purge({
                operationId,
                actor: { actorType: AuditActorType.USER, actorId },
                authorize: async (rootNodeId, transaction) => {
                    const capabilities = await this.authorization.resolveTrashCapabilities(actorId, rootNodeId, transaction);
                    if (!capabilities.capabilities.has(DocumentCapability.VIEW))
                        return 'not_found';
                    if (!capabilities.capabilities.has(DocumentCapability.DELETE))
                        return 'forbidden';
                    return 'allowed';
                },
            });
            const { deletedBytes: _deletedBytes, ...response } = result;
            return response;
        }
        catch (error) {
            if (!(error instanceof PurgeError))
                throw error;
            if (error.code === 'NOT_FOUND')
                throw new NotFoundException('Node not found');
            if (error.code === 'FORBIDDEN')
                throw new ForbiddenException('You do not have the required document capability');
            if (error.code === 'STORAGE_FAILURE')
                throw new ServiceUnavailableException('Document storage is temporarily unavailable');
            throw new ConflictException('Trash operation cannot be purged');
        }
    }
    isSerializationConflict(error) {
        if (!error || typeof error !== 'object' || !('code' in error))
            return false;
        if (error.code === 'P2034')
            return true;
        return (error.code === 'P2010' &&
            'meta' in error &&
            !!error.meta &&
            typeof error.meta === 'object' &&
            'code' in error.meta &&
            error.meta.code === '40001');
    }
    async isOriginalParentAvailable(client, parentId) {
        const ancestors = await client.$queryRaw `WITH RECURSIVE ancestor_chain AS (
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
        return (ancestors.length > 0 &&
            ancestors[0].type === NodeType.FOLDER &&
            ancestors.every((ancestor) => ancestor.trashOperationId === null));
    }
};
TrashService = __decorate([
    Injectable(),
    __param(2, Inject(STORAGE_SERVICE)),
    __param(3, Inject(TRASH_CONFIG)),
    __metadata("design:paramtypes", [DatabaseService,
        DocumentAuthorizationService, Object, Object])
], TrashService);
export { TrashService };
//# sourceMappingURL=trash.service.js.map