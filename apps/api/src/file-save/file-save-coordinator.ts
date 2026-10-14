import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FileBackingType, FileRevisionProvider, FileRevisionSource, FileSaveOperationStatus, FileSaveOperationType, finalizeFileMutationOperation, NodeType, Prisma } from '@dochub/database';
import { randomUUID } from 'node:crypto';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { FolderAccessService } from '../authorization/folder-access.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FileEngineRegistry } from '../file-engine/file-engine.registry.js';
import type { FileDescriptor, FileEngine, FileEngineSaveContext } from '../file-engine/file-engine.types.js';
import { STORAGE_CONFIG, type StorageConfig } from '../storage/storage.config.js';
import { asVersionedStorageProvider, STORAGE_PROVIDER, type StorageObjectRef, type StorageProvider, type StorageVersionMetadata, type VersionedStorageProvider } from '../storage/storage-provider.js';
import { StorageConflictError } from '../storage/storage.errors.js';
import { DriveService } from '../drive/drive.service.js';

export interface FileSaveRequest {
  userId: string;
  nodeId: string;
  engine: FileEngine;
  payload: unknown;
  operationId?: string;
}

export interface SaveAsCopyRequest extends FileSaveRequest {
  name: string;
  parentId: string | null;
}

interface ResolvedEditableFile {
  descriptor: FileDescriptor;
  fileId: string;
  ref: StorageObjectRef;
  driveFileRecordId: string;
  node: { id: string; name: string; parentId: string | null };
}

@Injectable()
export class FileSaveCoordinator {
  private readonly logger = new Logger(FileSaveCoordinator.name);
  private readonly versions: VersionedStorageProvider;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly folders: FolderAccessService,
    private readonly registry: FileEngineRegistry,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
    private readonly drive: DriveService,
  ) {
    this.versions = asVersionedStorageProvider(storage);
  }

  async save(request: FileSaveRequest): Promise<{ storageRevision: string; model: unknown }> {
    const target = await this.resolveEditable(request.userId, request.nodeId, request.engine);
    const expectedRevision = this.expectedRevision(request.payload);
    const operationId = this.operationId(request.operationId ?? this.payloadOperationId(request.payload));
    const replay = await this.replayOperation(operationId, target, request.engine, expectedRevision);
    if (replay) return replay;
    await this.assertNoUnresolvedMutation(target.fileId, operationId);

    const current = await this.storage.stat(target.ref);
    this.logger.debug({ event: 'file-save', stage: 'precheck', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, precheckRevision: current.revision ?? null });
    if (current.revision !== expectedRevision) {
      // A duplicate request can race the first response. Prefer its durable
      // operation result over misclassifying the caller as a remote conflict.
      const completed = await this.replayOperation(operationId, target, request.engine, expectedRevision);
      if (completed) return completed;
      await this.recordConflict(request.userId, target, request.engine.id, expectedRevision, current.revision);
      throw this.revisionConflict(current.revision, current.modifiedAt);
    }
    const prepared = await this.prepare(target, request.engine, request.payload, expectedRevision);

    let oldVersion: StorageVersionMetadata;
    try {
      oldVersion = await this.versions.getCurrentVersion(target.ref);
      this.logger.debug({ event: 'file-save', stage: 'preserve-before-replace', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, providerRevision: oldVersion.ref.versionId });
      await this.versions.preserveVersion(target.ref, oldVersion.ref);
      const duplicate = await this.beginOperation(operationId, target, request.engine, expectedRevision, request.userId, oldVersion);
      if (duplicate) return duplicate;
      const stored = await this.storage.replace(target.ref, { stream: prepared.stream, mimeType: prepared.mimeType }, { expectedRevision });
      if (!stored.metadata.revision) throw new ServiceUnavailableException('Storage did not return a new revision.');
      this.logger.debug({ event: 'file-save', stage: 'provider-replaced', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, replaceRevision: stored.metadata.revision });
      const replacedVersion = await this.versions.getCurrentVersion(target.ref);
      this.logger.debug({ event: 'file-save', stage: 'preserve-after-replace', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, replaceRevision: stored.metadata.revision, providerRevision: replacedVersion.ref.versionId });
      await this.versions.preserveVersion(target.ref, replacedVersion.ref);
      const finalVersion = await this.versions.getCurrentVersion(target.ref);
      this.logger.debug({ event: 'file-save', stage: 'final-provider-stat', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, replaceRevision: stored.metadata.revision, finalRevision: finalVersion.storageRevision, providerRevision: finalVersion.ref.versionId });
      await this.markProviderWritten(operationId, finalVersion);
      await finalizeFileMutationOperation(this.database.prisma, operationId);
      await this.prune(target.fileId, target.ref);
      this.logger.debug({ event: 'file-save', stage: 'completed', fileId: target.fileId, engine: request.engine.id, operationId, expectedRevision, finalRevision: finalVersion.storageRevision });
      return { storageRevision: finalVersion.storageRevision, model: await this.openModel(target, request.engine, finalVersion.storageRevision) };
    } catch (error) {
      if (error instanceof StorageConflictError) {
        const latest = await this.storage.stat(target.ref).catch(() => undefined);
        await this.database.prisma.fileSaveOperation.update({ where: { operationId }, data: { status: FileSaveOperationStatus.FAILED, failureReason: 'REVISION_CONFLICT' } }).catch(() => undefined);
        await this.recordConflict(request.userId, target, request.engine.id, expectedRevision, latest?.revision);
        throw this.revisionConflict(latest?.revision, latest?.modifiedAt);
      }
      if (error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
      this.logger.error({ event: 'file-mutation', operationId, fileId: target.fileId, operationType: FileSaveOperationType.SAVE, state: 'PENDING_OR_PROVIDER_WRITTEN', error: error instanceof Error ? error.name : 'UNKNOWN' });
      throw new ServiceUnavailableException('The file may have been saved, but history finalization is pending. Refresh before retrying.');
    }
  }

  private async replayOperation(operationId: string, target: ResolvedEditableFile, engine: FileEngine, expectedRevision: string): Promise<{ storageRevision: string; model: unknown } | null> {
    const existing = await this.database.prisma.fileSaveOperation.findUnique({ where: { operationId } });
    if (!existing) return null;
    if (existing.fileId !== target.fileId || existing.expectedRevision !== expectedRevision || existing.operationType !== FileSaveOperationType.SAVE) {
      throw new ConflictException('The save operation ID is already in use.');
    }
    if (existing.status === FileSaveOperationStatus.PROVIDER_WRITTEN) {
      await finalizeFileMutationOperation(this.database.prisma, operationId);
      const finalized = await this.database.prisma.fileSaveOperation.findUniqueOrThrow({ where: { operationId } });
      return { storageRevision: finalized.resultRevision!, model: await this.openModel(target, engine, finalized.resultRevision!) };
    }
    if (existing.status === FileSaveOperationStatus.COMPLETED && existing.resultRevision) {
      return { storageRevision: existing.resultRevision, model: await this.openModel(target, engine, existing.resultRevision) };
    }
    throw new ConflictException({ code: existing.status === FileSaveOperationStatus.FAILED ? 'FILE_MUTATION_FAILED' : 'FILE_MUTATION_IN_PROGRESS', message: existing.status === FileSaveOperationStatus.FAILED ? 'The previous save did not start and needs a new operation.' : 'This save is already being finalized.' });
  }

  private async beginOperation(operationId: string, target: ResolvedEditableFile, engine: FileEngine, expectedRevision: string, userId: string, previous: StorageVersionMetadata): Promise<{ storageRevision: string; model: unknown } | null> {
    try {
      await this.database.prisma.fileSaveOperation.create({
        data: {
          operationId,
          fileId: target.fileId,
          expectedRevision,
          operationType: FileSaveOperationType.SAVE,
          source: FileRevisionSource.MANUAL_SAVE,
          previousStorageRevision: previous.storageRevision,
          previousProviderVersionId: previous.ref.versionId,
          previousSizeBytes: previous.sizeBytes,
          previousChecksum: previous.checksum ?? null,
          createdById: userId,
        },
      });
      return null;
    } catch (error) {
      const replay = await this.replayOperation(operationId, target, engine, expectedRevision);
      if (replay) return replay;
      throw error;
    }
  }

  private async markProviderWritten(operationId: string, version: StorageVersionMetadata) {
    await this.database.prisma.fileSaveOperation.update({
      where: { operationId },
      data: {
        status: FileSaveOperationStatus.PROVIDER_WRITTEN,
        resultRevision: version.storageRevision,
        providerVersionId: version.ref.versionId,
        resultSizeBytes: version.sizeBytes,
        resultChecksum: version.checksum ?? null,
        providerWrittenAt: new Date(),
      },
    });
  }

  private async assertNoUnresolvedMutation(fileId: string, operationId: string) {
    const blocking = await this.database.prisma.fileSaveOperation.findFirst({
      where: { fileId, operationId: { not: operationId }, status: { in: [FileSaveOperationStatus.PENDING, FileSaveOperationStatus.PROVIDER_WRITTEN] } },
      select: { operationId: true, status: true },
    });
    if (blocking) {
      throw new ConflictException({ code: 'FILE_MUTATION_PENDING', message: 'A previous file mutation is still being finalized.' });
    }
  }

  async saveAsCopy(request: SaveAsCopyRequest): Promise<{ nodeId: string; name: string }> {
    const target = await this.resolveEditable(request.userId, request.nodeId, request.engine);
    const expectedRevision = this.expectedRevision(request.payload);
    await this.folders.requireCreate(request.userId, request.parentId);
    const current = await this.storage.stat(target.ref);
    const sourceVersion = current.revision === expectedRevision
      ? await this.versions.getCurrentVersion(target.ref)
      : await this.baseVersion(target.fileId, expectedRevision, target.descriptor.mimeType ?? 'application/octet-stream');
    if (!sourceVersion) throw this.revisionConflict(current.revision, current.modifiedAt);
    const prepared = await this.prepare(target, request.engine, request.payload, expectedRevision, this.versionSource(target.ref, sourceVersion));
    const stored = await this.storage.put({ stream: prepared.stream, mimeType: prepared.mimeType, filename: request.name });
    try {
      const createdVersion = await this.versions.getCurrentVersion(stored.ref);
      await this.versions.preserveVersion(stored.ref, createdVersion.ref);
      const finalVersion = await this.versions.getCurrentVersion(stored.ref);
      const result = await this.registerCopy(request, target, stored.ref, finalVersion, request.name);
      return result;
    } catch (error) {
      try {
        await this.storage.delete(stored.ref);
      } catch (cleanupError) {
        this.logger.error({ event: 'file-save-as-copy-compensation-failed', sourceFileId: target.fileId, provider: stored.ref.provider, objectId: stored.ref.objectId, error: cleanupError instanceof Error ? cleanupError.name : 'UNKNOWN' });
      }
      throw error;
    }
  }

  private async resolveEditable(userId: string, nodeId: string, engine: FileEngine): Promise<ResolvedEditableFile> {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.EDIT)) throw new ForbiddenException('You do not have the required document capability');
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, type: NodeType.FILE, trashOperationId: null },
      select: { id: true, name: true, parentId: true, file: { select: { id: true, backingType: true, driveFile: { select: { id: true, driveFileId: true, mimeType: true, sizeBytes: true, trashed: true, sourceStatus: true } } } } },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE ? node.file.driveFile : null;
    if (!node || !node.file || !source || source.trashed || source.sourceStatus === 'UNAVAILABLE') throw new NotFoundException('Node not found');
    const descriptor: FileDescriptor = { fileId: node.file.id, nodeId, name: node.name, mimeType: source.mimeType, extension: node.name.includes('.') ? `.${node.name.split('.').pop()!.toLowerCase()}` : null, size: source.sizeBytes === null ? null : Number(source.sizeBytes), storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId } };
    const resolved = this.registry.resolve(descriptor);
    if (resolved.engine.id !== engine.id || !resolved.capabilities.edit || !engine.prepareSave) throw new ConflictException('This file is not editable by the requested engine.');
    return { descriptor, fileId: node.file.id, ref: descriptor.storageRef!, driveFileRecordId: source.id, node: { id: node.id, name: node.name, parentId: node.parentId } };
  }

  private async prepare(target: ResolvedEditableFile, engine: FileEngine, payload: unknown, expectedRevision: string, source?: FileEngineSaveContext['source']) {
    if (!engine.prepareSave) throw new ConflictException('This file engine cannot save this file.');
    return engine.prepareSave(target.descriptor, payload, { storage: this.storage, expectedRevision, source });
  }

  private async openModel(target: ResolvedEditableFile, engine: FileEngine, revision: string) {
    if (!engine.openModel) return null;
    return engine.openModel(target.descriptor, { storage: this.storage, storageRevision: revision });
  }

  private async registerCopy(request: SaveAsCopyRequest, source: ResolvedEditableFile, ref: StorageObjectRef, version: StorageVersionMetadata, name: string) {
    const normalizedName = name.trim().normalize('NFC').toLowerCase();
    const integrationId = await this.drive.storageIntegrationId();
    const result = await this.database.prisma.$transaction(async (tx) => {
      const conflict = await tx.node.findFirst({ where: { parentId: request.parentId, normalizedName, trashOperationId: null }, select: { id: true } });
      if (conflict) throw new ConflictException('A node with this name already exists');
      const driveFile = await tx.driveFile.create({ data: { driveIntegrationId: integrationId, driveFileId: ref.objectId, name, mimeType: version.mimeType, normalizedType: this.driveType(version.mimeType), sizeBytes: version.sizeBytes, driveVersion: version.storageRevision, sourceStatus: 'CONNECTED', syncedAt: new Date() }, select: { id: true } });
      const node = await tx.node.create({ data: { parentId: request.parentId, type: NodeType.FILE, name, normalizedName, createdById: request.userId, updatedById: request.userId }, select: { id: true, name: true } });
      const file = await tx.file.create({ data: { nodeId: node.id, backingType: FileBackingType.GOOGLE_DRIVE, driveFileId: driveFile.id, revisionSequence: 1 } });
      await tx.fileRevision.create({ data: this.revisionData(file.id, 1, version, FileRevisionSource.SAVE_AS_COPY_INITIAL, request.userId) });
      await tx.auditLog.create({ data: { actorType: 'USER', actorId: request.userId, action: 'FILE_SAVE_AS_COPY', resourceType: 'NODE', resourceId: node.id, result: 'SUCCESS', metadata: { sourceFileId: source.fileId, sourceNodeId: source.node.id, fileId: file.id } } });
      await tx.outboxEvent.create({ data: { eventType: 'FILE_CONTENT_CHANGED', aggregateType: 'FILE', aggregateId: file.id, payload: { fileId: file.id, storageRevision: version.storageRevision, source: 'SAVE_AS_COPY_INITIAL' } } });
      return { nodeId: node.id, name: node.name };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return result;
  }

  private async baseVersion(fileId: string, storageRevision: string, mimeType: string) {
    const row = await this.database.prisma.fileRevision.findFirst({ where: { fileId, storageRevision }, orderBy: { sequence: 'desc' } });
    if (!row) return null;
    return { ref: { provider: row.provider === FileRevisionProvider.GOOGLE_DRIVE ? 'GOOGLE_DRIVE' : row.provider, versionId: row.providerVersionId } as StorageVersionMetadata['ref'], storageRevision: row.storageRevision, mimeType, sizeBytes: row.sizeBytes, ...(row.checksum ? { checksum: row.checksum } : {}) };
  }

  private versionSource(ref: StorageObjectRef, version: StorageVersionMetadata) {
    return { stat: async () => ({ provider: ref.provider, objectId: ref.objectId, mimeType: version.mimeType, sizeBytes: version.sizeBytes, ...(version.checksum ? { checksum: version.checksum } : {}), revision: version.storageRevision }), openRead: async () => this.versions.openVersion(ref, version.ref) };
  }

  private revisionData(fileId: string, sequence: number, version: StorageVersionMetadata, source: FileRevisionSource, createdById: string): Prisma.FileRevisionUncheckedCreateInput {
    return { fileId, sequence, provider: FileRevisionProvider.GOOGLE_DRIVE, providerVersionId: version.ref.versionId, storageRevision: version.storageRevision, sizeBytes: version.sizeBytes, checksum: version.checksum ?? null, source, createdById };
  }

  private async prune(fileId: string, ref: StorageObjectRef) {
    const rows = await this.database.prisma.fileRevision.findMany({ where: { fileId }, orderBy: { sequence: 'desc' } });
    const removable = rows.slice(this.storageConfig.versionHistoryLimit);
    for (const row of removable) {
      try {
        await this.versions.releaseVersion?.(ref, { provider: row.provider as StorageObjectRef['provider'], versionId: row.providerVersionId });
        await this.database.prisma.fileRevision.delete({ where: { id: row.id } });
      } catch {
        this.logger.warn('Version retention cleanup is pending.');
      }
    }
  }

  private expectedRevision(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || typeof (payload as { expectedRevision?: unknown }).expectedRevision !== 'string') throw new ConflictException('Expected revision is required.');
    return (payload as { expectedRevision: string }).expectedRevision;
  }

  private payloadOperationId(payload: unknown): string | undefined {
    return payload && typeof payload === 'object' && typeof (payload as { operationId?: unknown }).operationId === 'string'
      ? (payload as { operationId: string }).operationId
      : undefined;
  }

  private operationId(value?: string): string { return value && /^[A-Za-z0-9._:-]{1,200}$/u.test(value) ? value : randomUUID(); }
  private async recordConflict(userId: string, target: ResolvedEditableFile, engine: string, expectedRevision: string, currentRevision?: string) {
    try {
      await this.database.prisma.auditLog.create({ data: { actorType: 'USER', actorId: userId, action: 'FILE_SAVE_CONFLICT', resourceType: 'NODE', resourceId: target.node.id, result: 'FAILED', metadata: { fileId: target.fileId, engine, expectedRevision, currentRevision: currentRevision ?? null } } });
    } catch {
      this.logger.warn('Save conflict audit could not be recorded.');
    }
  }
  private revisionConflict(currentRevision?: string, modifiedAt?: Date) { return new ConflictException({ code: 'FILE_REVISION_CONFLICT', message: 'This file changed after you opened it.', currentRevision, modifiedAt: modifiedAt?.toISOString() }); }
  private driveType(mimeType: string): 'DOCX' | 'XLSX' | 'PPTX' | 'PDF' | 'IMAGE' | 'VIDEO' | 'BINARY' {
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'XLSX';
    if (mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'PPTX';
    if (mimeType === 'application/pdf') return 'PDF';
    if (mimeType.startsWith('image/')) return 'IMAGE';
    if (mimeType.startsWith('video/')) return 'VIDEO';
    return 'BINARY';
  }
}
