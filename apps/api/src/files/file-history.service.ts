import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { FileBackingType, FileRevisionProvider, FileRevisionSource, NodeType } from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_PROVIDER, type StorageObjectRef, type StorageProvider, type VersionedStorageProvider } from '../storage/storage-provider.js';
import { asVersionedStorageProvider } from '../storage/storage-provider.js';
import { STORAGE_CONFIG, type StorageConfig } from '../storage/storage.config.js';
import { StorageObjectNotFoundError } from '../storage/storage.errors.js';
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

  async restoreVersion(userId: string, nodeId: string, versionId: string, expectedRevision?: string): Promise<unknown> {
    const file = await this.driveFile(userId, nodeId, DocumentCapability.RESTORE_VERSION);
    if (!file) return this.legacy.restoreVersion(userId, nodeId, versionId);
    if (!expectedRevision) throw new ConflictException({ code: 'FILE_REVISION_CONFLICT', message: 'The current file revision is required before restore.' });
    const selected = await this.database.prisma.fileRevision.findFirst({ where: { id: versionId, fileId: file.fileId } });
    if (!selected) throw new NotFoundException('Version not found');
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
    let stored;
    try {
      if (historical.metadata.sizeBytes === null) throw new ServiceUnavailableException('The historical version is unavailable.');
      await this.versions.preserveVersion(ref, current.ref);
      stored = await this.storageReplace(ref, historical, current.storageRevision, historical.metadata.mimeType);
    } finally {
      await historical.cleanup?.().catch(() => undefined);
    }
    const next = await this.versions.getCurrentVersion(ref);
    await this.versions.preserveVersion(ref, next.ref);
    await this.database.prisma.$transaction(async (tx) => {
      const fileRow = await tx.file.update({ where: { id: file.fileId }, data: { revisionSequence: { increment: 1 } }, select: { revisionSequence: true, driveFileId: true } });
      if (fileRow.driveFileId) await tx.driveFile.update({ where: { id: fileRow.driveFileId }, data: { sizeBytes: next.sizeBytes, driveVersion: next.storageRevision, syncedAt: new Date() } });
      await tx.fileRevision.create({ data: { fileId: file.fileId, sequence: fileRow.revisionSequence, provider: FileRevisionProvider.GOOGLE_DRIVE, providerVersionId: next.ref.versionId, storageRevision: next.storageRevision, sizeBytes: next.sizeBytes, checksum: next.checksum ?? null, source: FileRevisionSource.RESTORE, createdById: userId } });
      await tx.auditLog.create({ data: { actorType: 'USER', actorId: userId, action: 'FILE_RESTORE', resourceType: 'NODE', resourceId: nodeId, result: 'SUCCESS', metadata: { fileId: file.fileId, sourceVersionId: versionId, resultRevision: next.storageRevision } } });
      await tx.outboxEvent.create({ data: { eventType: 'FILE_CONTENT_CHANGED', aggregateType: 'FILE', aggregateId: file.fileId, payload: { fileId: file.fileId, storageRevision: next.storageRevision, source: 'RESTORE' } } });
    });
    await this.prune(file.fileId, ref);
    return { storageRevision: stored.metadata.revision ?? next.storageRevision };
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
