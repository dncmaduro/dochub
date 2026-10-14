import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FileBackingType, FileRevisionSource, FileSaveOperationStatus, FileSaveOperationType, finalizeFileMutationOperation, NodeType } from '@dochub/database';
import { randomUUID } from 'node:crypto';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_PROVIDER, type StorageObjectRef, type StorageProvider, type VersionedStorageProvider } from '../storage/storage-provider.js';
import { asVersionedStorageProvider } from '../storage/storage-provider.js';
import { STORAGE_CONFIG, type StorageConfig } from '../storage/storage.config.js';
import { StorageConflictError, StorageObjectNotFoundError } from '../storage/storage.errors.js';
import { FilesService, type FileVersionListResponse } from './files.service.js';

export interface FileRevisionListResponse {
  nodeId: string;
  currentRevision?: string;
  items: Array<{
    id: string;
    sequence: number;
    source: FileRevisionSource;
    createdAt: Date;
    actorDisplayName: string | null;
    sizeBytes: string | null;
    isCurrent: boolean;
  }>;
}

@Injectable()
export class FileHistoryService {
  private readonly logger = new Logger(FileHistoryService.name);
  private readonly versions: VersionedStorageProvider;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
    private readonly legacy: FilesService,
  ) {
    this.versions = asVersionedStorageProvider(storage);
  }

  async listVersions(userId: string, nodeId: string): Promise<FileRevisionListResponse | FileVersionListResponse> {
    const file = await this.driveFile(userId, nodeId, DocumentCapability.VIEW);
    if (!file) return this.legacy.listVersions(userId, nodeId);
    const rows = await this.database.prisma.fileRevision.findMany({ where: { fileId: file.fileId }, orderBy: { sequence: 'desc' }, include: { createdBy: { select: { displayName: true } } } });
    const current = await this.versions.getCurrentVersion({ provider: 'GOOGLE_DRIVE', objectId: file.objectId });
    return { nodeId, currentRevision: current.storageRevision, items: rows.map((row) => ({ id: row.id, sequence: row.sequence, source: row.source, createdAt: row.createdAt, actorDisplayName: row.createdBy?.displayName ?? null, sizeBytes: row.sizeBytes?.toString() ?? null, isCurrent: row.storageRevision === current.storageRevision })) };
  }

  async restoreVersion(userId: string, nodeId: string, versionId: string, expectedRevision?: string, requestedOperationId?: string): Promise<unknown> {
    const file = await this.driveFile(userId, nodeId, DocumentCapability.RESTORE_VERSION);
    if (!file) return this.legacy.restoreVersion(userId, nodeId, versionId);
    if (!expectedRevision) throw new ConflictException({ code: 'FILE_REVISION_CONFLICT', message: 'The current file revision is required before restore.' });
    const operationId = this.operationId(requestedOperationId);
    const selected = await this.database.prisma.fileRevision.findFirst({ where: { id: versionId, fileId: file.fileId } });
    if (!selected) throw new NotFoundException('Version not found');
    const replay = await this.replayRestore(operationId, file.fileId, versionId, expectedRevision);
    if (replay) return replay;
    await this.assertNoUnresolvedMutation(file.fileId, operationId);
    const ref: StorageObjectRef = { provider: 'GOOGLE_DRIVE', objectId: file.objectId };
    const current = await this.versions.getCurrentVersion(ref);
    if (current.storageRevision !== expectedRevision) throw new ConflictException({ code: 'FILE_REVISION_CONFLICT', message: 'This file changed after you opened version history.', currentRevision: current.storageRevision });
    const selectedRef = { provider: 'GOOGLE_DRIVE' as const, versionId: selected.providerVersionId };
    let historical;
    try {
      historical = await this.versions.openVersion(ref, selectedRef);
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) throw new NotFoundException('The historical version is unavailable.');
      throw new ServiceUnavailableException('The historical version is unavailable.');
    }
    try {
      if (historical.metadata.sizeBytes === null) throw new ServiceUnavailableException('The historical version is unavailable.');
      await this.versions.preserveVersion(ref, current.ref);
      const duplicate = await this.beginRestore(operationId, file.fileId, versionId, expectedRevision, userId);
      if (duplicate) return duplicate;
      await this.storageReplace(ref, historical, current.storageRevision, historical.metadata.mimeType);
    } catch (error) {
      if (error instanceof StorageConflictError) {
        await this.database.prisma.fileSaveOperation.update({ where: { operationId }, data: { status: FileSaveOperationStatus.FAILED, failureReason: 'REVISION_CONFLICT' } }).catch(() => undefined);
        const latest = await this.versions.getCurrentVersion(ref).catch(() => undefined);
        throw new ConflictException({ code: 'FILE_REVISION_CONFLICT', message: 'This file changed after you opened version history.', currentRevision: latest?.storageRevision });
      }
      throw error;
    } finally {
      await historical.cleanup?.().catch(() => undefined);
    }
    try {
      const replacedVersion = await this.versions.getCurrentVersion(ref);
      await this.versions.preserveVersion(ref, replacedVersion.ref);
      const next = await this.versions.getCurrentVersion(ref);
      await this.database.prisma.fileSaveOperation.update({
        where: { operationId },
        data: {
          status: FileSaveOperationStatus.PROVIDER_WRITTEN,
          resultRevision: next.storageRevision,
          providerVersionId: next.ref.versionId,
          resultSizeBytes: next.sizeBytes,
          resultChecksum: next.checksum ?? null,
          providerWrittenAt: new Date(),
        },
      });
      await finalizeFileMutationOperation(this.database.prisma, operationId);
      await this.prune(file.fileId, ref);
      return { storageRevision: next.storageRevision, operationId };
    } catch (error) {
      this.logger.error({ event: 'file-mutation', operationId, fileId: file.fileId, operationType: FileSaveOperationType.RESTORE, state: 'PENDING_OR_PROVIDER_WRITTEN', error: error instanceof Error ? error.name : 'UNKNOWN' });
      throw new ServiceUnavailableException('The file may have been restored, but history finalization is pending. Refresh before retrying.');
    }
  }

  private async replayRestore(operationId: string, fileId: string, sourceRevisionId: string, expectedRevision: string): Promise<{ storageRevision: string; operationId: string } | null> {
    const operation = await this.database.prisma.fileSaveOperation.findUnique({ where: { operationId } });
    if (!operation) return null;
    if (operation.fileId !== fileId || operation.operationType !== FileSaveOperationType.RESTORE || operation.sourceRevisionId !== sourceRevisionId || operation.expectedRevision !== expectedRevision) {
      throw new ConflictException('The restore operation ID is already in use.');
    }
    if (operation.status === FileSaveOperationStatus.PROVIDER_WRITTEN) {
      await finalizeFileMutationOperation(this.database.prisma, operationId);
      const finalized = await this.database.prisma.fileSaveOperation.findUniqueOrThrow({ where: { operationId } });
      return { storageRevision: finalized.resultRevision!, operationId };
    }
    if (operation.status === FileSaveOperationStatus.COMPLETED && operation.resultRevision) return { storageRevision: operation.resultRevision, operationId };
    throw new ConflictException({ code: operation.status === FileSaveOperationStatus.FAILED ? 'FILE_MUTATION_FAILED' : 'FILE_MUTATION_IN_PROGRESS', message: operation.status === FileSaveOperationStatus.FAILED ? 'The previous restore did not start and needs a new operation.' : 'This restore is already being finalized.' });
  }

  private async beginRestore(operationId: string, fileId: string, sourceRevisionId: string, expectedRevision: string, userId: string): Promise<{ storageRevision: string; operationId: string } | null> {
    try {
      await this.database.prisma.fileSaveOperation.create({ data: { operationId, fileId, expectedRevision, operationType: FileSaveOperationType.RESTORE, source: FileRevisionSource.RESTORE, sourceRevisionId, createdById: userId } });
      return null;
    } catch {
      return this.replayRestore(operationId, fileId, sourceRevisionId, expectedRevision);
    }
  }

  private async assertNoUnresolvedMutation(fileId: string, operationId: string) {
    const blocking = await this.database.prisma.fileSaveOperation.findFirst({ where: { fileId, operationId: { not: operationId }, status: { in: [FileSaveOperationStatus.PENDING, FileSaveOperationStatus.PROVIDER_WRITTEN] } }, select: { operationId: true } });
    if (blocking) throw new ConflictException({ code: 'FILE_MUTATION_PENDING', message: 'A previous file mutation is still being finalized.' });
  }

  private operationId(value?: string) {
    return value && /^[A-Za-z0-9._:-]{1,200}$/u.test(value) ? value : randomUUID();
  }

  private async prune(fileId: string, ref: StorageObjectRef) {
    const rows = await this.database.prisma.fileRevision.findMany({ where: { fileId }, orderBy: { sequence: 'desc' } });
    for (const row of rows.slice(this.storageConfig.versionHistoryLimit)) {
      try {
        await this.versions.releaseVersion?.(ref, { provider: row.provider as StorageObjectRef['provider'], versionId: row.providerVersionId });
        await this.database.prisma.fileRevision.delete({ where: { id: row.id } });
      } catch {
        this.logger.warn('Version retention cleanup is pending.');
      }
    }
  }

  private async storageReplace(ref: StorageObjectRef, source: { stream: NodeJS.ReadableStream; metadata: { mimeType: string } }, expectedRevision: string, mimeType: string) {
    const stored = await (this.storage as StorageProvider).replace(ref, { stream: source.stream as import('node:stream').Readable, mimeType }, { expectedRevision });
    return stored;
  }

  private async driveFile(userId: string, nodeId: string, capability: DocumentCapability) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(capability)) {
      if (capability === DocumentCapability.VIEW) throw new NotFoundException('Node not found');
      throw new ForbiddenException('You do not have the required document capability');
    }
    const node = await this.database.prisma.node.findFirst({ where: { id: nodeId, type: NodeType.FILE, trashOperationId: null }, select: { file: { select: { id: true, backingType: true, driveFile: { select: { driveFileId: true } } } } } });
    if (!node?.file) throw new NotFoundException('Node not found');
    if (node.file.backingType !== FileBackingType.GOOGLE_DRIVE || !node.file.driveFile) return null;
    return { fileId: node.file.id, objectId: node.file.driveFile.driveFileId };
  }

}
