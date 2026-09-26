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
var FilesService_1;
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, } from '@nestjs/common';
import { AuditActorType, AuditResult, DocumentRole, FileVersionSource, FileProcessingTaskType, isSearchableFileMimeType, NodeType, SystemRole, UserStatus, } from '@dochub/database';
import { isUUID } from 'class-validator';
import { DocumentAuthorizationService, } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import { FileValidationService } from './file-validation.service.js';
let FilesService = FilesService_1 = class FilesService {
    database;
    authorization;
    validation;
    storage;
    logger = new Logger(FilesService_1.name);
    constructor(database, authorization, validation, storage) {
        this.database = database;
        this.authorization = authorization;
        this.validation = validation;
        this.storage = storage;
    }
    async createInitial(actorUserId, upload) {
        const metadata = await this.validation.validate(upload);
        await this.assertInitialDestination(actorUserId, upload.parentId);
        const nodeId = randomUUID();
        const fileId = randomUUID();
        const versionId = randomUUID();
        const storageKey = this.storageKey(fileId, versionId);
        await this.storage.putStream(storageKey, createReadStream(upload.tempPath));
        try {
            return await this.database.prisma.$transaction(async (transaction) => {
                await this.assertInitialDestination(actorUserId, upload.parentId, transaction);
                const node = await transaction.node.create({
                    data: {
                        id: nodeId,
                        parentId: upload.parentId,
                        type: NodeType.FILE,
                        name: metadata.nodeName,
                        normalizedName: metadata.normalizedNodeName,
                        createdById: actorUserId,
                        updatedById: actorUserId,
                    },
                    select: {
                        id: true,
                        parentId: true,
                        type: true,
                        name: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                });
                await transaction.file.create({
                    data: { id: fileId, nodeId },
                });
                const version = await transaction.fileVersion.create({
                    data: {
                        id: versionId,
                        fileId,
                        versionNumber: 1,
                        storageKey,
                        originalFilename: metadata.originalFilename,
                        mimeType: metadata.mimeType,
                        extension: metadata.extension,
                        sizeBytes: metadata.sizeBytes,
                        sha256: metadata.sha256,
                        source: FileVersionSource.UPLOAD,
                        createdById: actorUserId,
                    },
                });
                await transaction.file.update({
                    where: { id: fileId },
                    data: { versionCounter: 1, currentVersionId: versionId },
                });
                await this.createTextExtractionTask(transaction, versionId, metadata.mimeType);
                await transaction.permissionEntry.create({
                    data: {
                        nodeId,
                        userId: actorUserId,
                        role: DocumentRole.OWNER,
                        createdById: actorUserId,
                    },
                });
                await this.writeAudit(transaction, {
                    actorUserId,
                    action: 'FILE_UPLOADED',
                    resourceType: 'NODE',
                    resourceId: nodeId,
                    metadata: {
                        fileId,
                        versionId,
                        versionNumber: 1,
                        parentId: upload.parentId,
                        mimeType: metadata.mimeType,
                        sizeBytes: metadata.sizeBytes.toString(),
                    },
                });
                return this.response(node, { id: fileId, currentVersionId: versionId }, version, new Set(Object.values(DocumentCapability)));
            });
        }
        catch (error) {
            await this.deleteOrphan(storageKey);
            this.throwDomainConflict(error);
            throw error;
        }
    }
    async createVersion(actorUserId, nodeId, upload) {
        this.assertUuid(nodeId, 'Invalid node ID');
        const metadata = await this.validation.validate(upload);
        const earlyTarget = await this.requireEditableFile(actorUserId, nodeId);
        const versionId = randomUUID();
        const storageKey = this.storageKey(earlyTarget.fileId, versionId);
        await this.storage.putStream(storageKey, createReadStream(upload.tempPath));
        try {
            return await this.database.prisma.$transaction(async (transaction) => {
                const target = await this.requireEditableFile(actorUserId, nodeId, transaction);
                const lockedFiles = await transaction.$queryRaw `SELECT "id", "versionCounter"
          FROM "File"
          WHERE "id" = ${target.fileId}::uuid
            AND "nodeId" = ${nodeId}::uuid
          FOR UPDATE`;
                const lockedFile = lockedFiles[0];
                if (!lockedFile) {
                    throw new ConflictException('File metadata is unavailable');
                }
                const versionNumber = lockedFile.versionCounter + 1;
                const version = await transaction.fileVersion.create({
                    data: {
                        id: versionId,
                        fileId: lockedFile.id,
                        versionNumber,
                        storageKey,
                        originalFilename: metadata.originalFilename,
                        mimeType: metadata.mimeType,
                        extension: metadata.extension,
                        sizeBytes: metadata.sizeBytes,
                        sha256: metadata.sha256,
                        source: FileVersionSource.UPLOAD,
                        createdById: actorUserId,
                    },
                });
                await transaction.file.update({
                    where: { id: lockedFile.id },
                    data: {
                        versionCounter: versionNumber,
                        currentVersionId: versionId,
                    },
                });
                await this.createTextExtractionTask(transaction, versionId, metadata.mimeType);
                await this.writeAudit(transaction, {
                    actorUserId,
                    action: 'FILE_VERSION_CREATED',
                    resourceType: 'FILE_VERSION',
                    resourceId: versionId,
                    metadata: {
                        fileId: lockedFile.id,
                        nodeId,
                        versionNumber,
                        mimeType: metadata.mimeType,
                        sizeBytes: metadata.sizeBytes.toString(),
                    },
                });
                return this.response(target, { id: lockedFile.id, currentVersionId: versionId }, version, target.capabilities);
            });
        }
        catch (error) {
            await this.deleteOrphan(storageKey);
            this.throwDomainConflict(error);
            throw error;
        }
    }
    async assertInitialDestination(actorUserId, parentId, client = this.database.prisma) {
        if (parentId === null) {
            const user = await client.user.findUnique({
                where: { id: actorUserId },
                select: { status: true, systemRole: true },
            });
            if (user?.status !== UserStatus.ACTIVE ||
                user.systemRole !== SystemRole.ADMIN) {
                throw new ForbiddenException('Root placement requires an active administrator');
            }
            return;
        }
        this.assertUuid(parentId, 'Invalid parent ID');
        const parent = await this.requireVisibleNode(actorUserId, parentId, client);
        if (parent.type !== NodeType.FOLDER) {
            throw new ConflictException('A file cannot be used as a parent folder');
        }
        this.requireCapability(parent.capabilities, DocumentCapability.CREATE);
    }
    async requireEditableFile(actorUserId, nodeId, client = this.database.prisma) {
        const node = await this.requireVisibleNode(actorUserId, nodeId, client, true);
        if (node.type !== NodeType.FILE) {
            throw new ConflictException('A folder cannot receive file versions');
        }
        if (!node.fileId) {
            throw new ConflictException('File metadata is unavailable');
        }
        this.requireCapability(node.capabilities, DocumentCapability.EDIT);
        return node;
    }
    async requireVisibleNode(actorUserId, nodeId, client, includeFile = false) {
        const node = await client.node.findFirst({
            where: { id: nodeId, trashOperationId: null },
            select: {
                id: true,
                parentId: true,
                type: true,
                name: true,
                createdAt: true,
                updatedAt: true,
                ...(includeFile ? { file: { select: { id: true } } } : {}),
            },
        });
        if (!node) {
            throw new NotFoundException('Node not found');
        }
        const resolved = await this.authorization.resolveCapabilities(actorUserId, nodeId, client);
        if (!resolved.capabilities.has(DocumentCapability.VIEW)) {
            throw new NotFoundException('Node not found');
        }
        return {
            ...node,
            ...(includeFile ? { fileId: node.file?.id } : {}),
            capabilities: resolved.capabilities,
        };
    }
    requireCapability(capabilities, capability) {
        if (!capabilities.has(capability)) {
            throw new ForbiddenException('You do not have the required document capability');
        }
    }
    storageKey(fileId, versionId) {
        return `files/${fileId}/versions/${versionId}`;
    }
    response(node, file, version, capabilities) {
        return {
            node: {
                id: node.id,
                parentId: node.parentId,
                type: node.type,
                name: node.name,
                createdAt: node.createdAt,
                updatedAt: node.updatedAt,
                capabilities: Object.values(DocumentCapability).filter((capability) => capabilities.has(capability)),
            },
            file,
            version: {
                id: version.id,
                versionNumber: version.versionNumber,
                originalFilename: version.originalFilename,
                mimeType: version.mimeType,
                extension: version.extension,
                sizeBytes: version.sizeBytes.toString(),
                sha256: version.sha256,
                createdAt: version.createdAt,
            },
        };
    }
    async writeAudit(transaction, input) {
        await transaction.auditLog.create({
            data: {
                actorType: AuditActorType.USER,
                actorId: input.actorUserId,
                action: input.action,
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                result: AuditResult.SUCCESS,
                metadata: input.metadata,
            },
        });
    }
    async createTextExtractionTask(transaction, fileVersionId, mimeType) {
        if (!isSearchableFileMimeType(mimeType))
            return;
        await transaction.fileProcessingTask.create({
            data: { fileVersionId, type: FileProcessingTaskType.TEXT_EXTRACTION },
        });
    }
    async deleteOrphan(storageKey) {
        await this.storage.delete(storageKey).catch(() => {
            this.logger.warn('Upload database failure left a storage orphan');
        });
    }
    throwDomainConflict(error) {
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'P2002') {
            throw new ConflictException('A node with this name already exists');
        }
    }
    assertUuid(value, message) {
        if (!isUUID(value)) {
            throw new BadRequestException(message);
        }
    }
};
FilesService = FilesService_1 = __decorate([
    Injectable(),
    __param(3, Inject(STORAGE_SERVICE)),
    __metadata("design:paramtypes", [DatabaseService,
        DocumentAuthorizationService,
        FileValidationService, Object])
], FilesService);
export { FilesService };
//# sourceMappingURL=files.service.js.map