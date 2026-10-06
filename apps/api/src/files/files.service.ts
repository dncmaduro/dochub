import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  DocumentRole,
  FileVersionSource,
  FileProcessingTaskType,
  isSearchableFileMimeType,
  NodeType,
  Prisma,
  UserStatus,
} from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { isUUID } from 'class-validator';
import {
  DocumentAuthorizationService,
  type DocumentAuthorizationClient,
} from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import { FileValidationService } from './file-validation.service.js';
import type { TempUpload } from './file-upload.types.js';
import {
  OfficeFileKind,
  OfficeLocale,
  OfficeTemplateService,
} from './office-template.service.js';
import { normalizeNodeName } from '../nodes/node-name.js';

const OFFICE_CREATION_RETRIES = 3;

interface VisibleNode {
  id: string;
  parentId: string | null;
  type: NodeType;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  fileId?: string;
  currentVersionId?: string | null;
  capabilities: ReadonlySet<DocumentCapability>;
}

export interface UploadResponse {
  node: {
    id: string;
    parentId: string | null;
    type: NodeType;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    capabilities: DocumentCapability[];
  };
  file: { id: string; currentVersionId: string };
  version: {
    id: string;
    versionNumber: number;
    originalFilename: string;
    mimeType: string;
    extension: string | null;
    sizeBytes: string;
    sha256: string;
    createdAt: Date;
  };
}

export interface FileVersionListResponse {
  nodeId: string;
  items: Array<{
    id: string;
    versionNumber: number;
    source: FileVersionSource;
    sourceVersionId: string | null;
    originalFilename: string;
    mimeType: string;
    extension: string | null;
    sizeBytes: string;
    createdAt: Date;
    isCurrent: boolean;
  }>;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly validation: FileValidationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly officeTemplates: OfficeTemplateService = new OfficeTemplateService(),
  ) {}

  async createOffice(
    actorUserId: string,
    kind: OfficeFileKind,
    parentId: string | null,
    locale = OfficeLocale.EN,
  ): Promise<UploadResponse> {
    const { template, bytes } = await this.officeTemplates.read(kind, locale);
    const sizeBytes = BigInt(bytes.length);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await this.assertInitialDestination(actorUserId, parentId);

    const nodeId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const storageKey = this.storageKey(fileId, versionId);

    try {
      await this.storage.putStream(storageKey, Readable.from(bytes));
      for (let attempt = 0; attempt < OFFICE_CREATION_RETRIES; attempt += 1) {
        try {
          return await this.database.prisma.$transaction(
            async (transaction) => {
              await this.assertInitialDestination(
                actorUserId,
                parentId,
                transaction,
              );
              const name = await this.availableNodeName(
                parentId,
                template.filename,
                transaction,
              );
              const node = await transaction.node.create({
                data: {
                  id: nodeId,
                  parentId,
                  type: NodeType.FILE,
                  name: name.name,
                  normalizedName: name.normalizedName,
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
              await transaction.file.create({ data: { id: fileId, nodeId } });
              const version = await transaction.fileVersion.create({
                data: {
                  id: versionId,
                  fileId,
                  versionNumber: 1,
                  storageKey,
                  originalFilename: name.name,
                  mimeType: template.mimeType,
                  extension: template.extension,
                  sizeBytes,
                  sha256,
                  source: FileVersionSource.SYSTEM,
                  createdById: actorUserId,
                },
              });
              await transaction.file.update({
                where: { id: fileId },
                data: { versionCounter: 1, currentVersionId: versionId },
              });
              await this.createTextExtractionTask(
                transaction,
                versionId,
                template.mimeType,
              );
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
                action: 'FILE_CREATED',
                resourceType: 'NODE',
                resourceId: nodeId,
                metadata: {
                  fileId,
                  versionId,
                  versionNumber: 1,
                  parentId,
                  kind,
                  source: FileVersionSource.SYSTEM,
                  mimeType: template.mimeType,
                  sizeBytes: sizeBytes.toString(),
                },
              });
              return this.response(
                node,
                { id: fileId, currentVersionId: versionId },
                version,
                new Set(Object.values(DocumentCapability)),
              );
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (
            this.isCreationRace(error) &&
            attempt + 1 < OFFICE_CREATION_RETRIES
          ) {
            continue;
          }
          this.throwDomainConflict(error);
          throw error;
        }
      }
      throw new ConflictException('A node with this name already exists');
    } catch (error) {
      await this.deleteOrphan(storageKey);
      throw error;
    }
  }

  async createInitial(
    actorUserId: string,
    upload: TempUpload,
  ): Promise<UploadResponse> {
    const metadata = await this.validation.validate(upload);
    await this.assertInitialDestination(actorUserId, upload.parentId);

    const nodeId = randomUUID();
    const fileId = randomUUID();
    const versionId = randomUUID();
    const storageKey = this.storageKey(fileId, versionId);
    await this.storage.putStream(storageKey, createReadStream(upload.tempPath));

    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        await this.assertInitialDestination(
          actorUserId,
          upload.parentId,
          transaction,
        );
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
        await this.createTextExtractionTask(
          transaction,
          versionId,
          metadata.mimeType,
        );
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
        return this.response(
          node,
          { id: fileId, currentVersionId: versionId },
          version,
          new Set(Object.values(DocumentCapability)),
        );
      });
    } catch (error) {
      await this.deleteOrphan(storageKey);
      this.throwDomainConflict(error);
      throw error;
    }
  }

  async createVersion(
    actorUserId: string,
    nodeId: string,
    upload: TempUpload,
  ): Promise<UploadResponse> {
    this.assertUuid(nodeId, 'Invalid node ID');
    const metadata = await this.validation.validate(upload);
    const earlyTarget = await this.requireEditableFile(actorUserId, nodeId);
    const versionId = randomUUID();
    const storageKey = this.storageKey(earlyTarget.fileId, versionId);
    await this.storage.putStream(storageKey, createReadStream(upload.tempPath));

    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        const target = await this.requireEditableFile(
          actorUserId,
          nodeId,
          transaction,
        );
        const lockedFiles = await transaction.$queryRaw<
          Array<{ id: string; versionCounter: number; currentVersionId: string | null }>
        >`SELECT "id", "versionCounter", "currentVersionId"
          FROM "File"
          WHERE "id" = ${target.fileId}::uuid
            AND "nodeId" = ${nodeId}::uuid
          FOR UPDATE`;
        const lockedFile = lockedFiles[0];
        if (!lockedFile) {
          throw new ConflictException('File metadata is unavailable');
        }
        if (lockedFile.currentVersionId !== earlyTarget.currentVersionId) {
          // Concurrent uploads remain serialized into successive immutable
          // versions. An editor finalization, however, is based on a specific
          // immutable version, so an upload prepared before it must not append
          // blindly after that EDITOR transition.
          const current = lockedFile.currentVersionId
            ? await transaction.fileVersion.findUnique({
                where: {
                  fileId_id: {
                    fileId: lockedFile.id,
                    id: lockedFile.currentVersionId,
                  },
                },
                select: { source: true },
              })
            : null;
          if (!current || current.source === FileVersionSource.EDITOR) {
            throw new ConflictException('File version changed before upload completed');
          }
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
        await this.createTextExtractionTask(
          transaction,
          versionId,
          metadata.mimeType,
        );
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
        return this.response(
          target,
          { id: lockedFile.id, currentVersionId: versionId },
          version,
          target.capabilities,
        );
      });
    } catch (error) {
      await this.deleteOrphan(storageKey);
      this.throwDomainConflict(error);
      throw error;
    }
  }

  async listVersions(
    actorUserId: string,
    nodeId: string,
  ): Promise<FileVersionListResponse> {
    this.assertUuid(nodeId, 'Invalid node ID');
    const target = await this.requireVersionedFile(actorUserId, nodeId);
    const versions = await this.database.prisma.fileVersion.findMany({
      where: { fileId: target.fileId },
      select: {
        id: true,
        versionNumber: true,
        source: true,
        sourceVersionId: true,
        originalFilename: true,
        mimeType: true,
        extension: true,
        sizeBytes: true,
        createdAt: true,
      },
      orderBy: [{ versionNumber: 'desc' }, { id: 'desc' }],
    });
    return {
      nodeId,
      items: versions.map((version) => ({
        ...version,
        sizeBytes: version.sizeBytes.toString(),
        isCurrent: version.id === target.currentVersionId,
      })),
    };
  }

  async restoreVersion(
    actorUserId: string,
    nodeId: string,
    sourceVersionId: string,
  ): Promise<UploadResponse> {
    this.assertUuid(nodeId, 'Invalid node ID');
    this.assertUuid(sourceVersionId, 'Invalid version ID');
    const earlyTarget = await this.requireVersionedFile(actorUserId, nodeId);
    this.requireCapability(
      earlyTarget.capabilities,
      DocumentCapability.RESTORE_VERSION,
    );
    const source = await this.database.prisma.fileVersion.findFirst({
      where: { id: sourceVersionId, fileId: earlyTarget.fileId },
      select: {
        id: true,
        storageKey: true,
        originalFilename: true,
        mimeType: true,
        extension: true,
        sizeBytes: true,
        sha256: true,
      },
    });
    if (!source) throw new NotFoundException('File version not found');

    const versionId = randomUUID();
    const storageKey = this.storageKey(earlyTarget.fileId, versionId);
    const sourceStream = await this.storage.openReadStream(source.storageKey);
    await this.storage.putStream(storageKey, sourceStream);
    try {
      const physical = await this.storage.stat(storageKey);
      if (physical.sizeBytes !== source.sizeBytes) {
        throw new ConflictException('Restored version bytes are unavailable');
      }
      return await this.database.prisma.$transaction(async (transaction) => {
        const target = await this.requireVersionedFile(
          actorUserId,
          nodeId,
          transaction,
        );
        this.requireCapability(
          target.capabilities,
          DocumentCapability.RESTORE_VERSION,
        );
        const lockedFiles = await transaction.$queryRaw<
          Array<{ id: string; versionCounter: number }>
        >`SELECT "id", "versionCounter" FROM "File"
          WHERE "id" = ${target.fileId}::uuid
            AND "nodeId" = ${nodeId}::uuid
          FOR UPDATE`;
        const lockedFile = lockedFiles[0];
        if (!lockedFile) {
          throw new ConflictException('File metadata is unavailable');
        }
        const lockedSource = await transaction.fileVersion.findFirst({
          where: { id: sourceVersionId, fileId: lockedFile.id },
          select: {
            originalFilename: true,
            mimeType: true,
            extension: true,
            sizeBytes: true,
            sha256: true,
          },
        });
        if (!lockedSource) throw new NotFoundException('File version not found');
        const versionNumber = lockedFile.versionCounter + 1;
        const version = await transaction.fileVersion.create({
          data: {
            id: versionId,
            fileId: lockedFile.id,
            versionNumber,
            storageKey,
            originalFilename: lockedSource.originalFilename,
            mimeType: lockedSource.mimeType,
            extension: lockedSource.extension,
            sizeBytes: lockedSource.sizeBytes,
            sha256: lockedSource.sha256,
            source: FileVersionSource.RESTORE,
            sourceVersionId,
            createdById: actorUserId,
          },
        });
        await transaction.file.update({
          where: { id: lockedFile.id },
          data: { versionCounter: versionNumber, currentVersionId: versionId },
        });
        await this.createTextExtractionTask(
          transaction,
          versionId,
          lockedSource.mimeType,
        );
        await this.writeAudit(transaction, {
          actorUserId,
          action: 'FILE_VERSION_RESTORED',
          resourceType: 'FILE_VERSION',
          resourceId: versionId,
          metadata: {
            fileId: lockedFile.id,
            nodeId,
            versionNumber,
            sourceVersionId,
            mimeType: lockedSource.mimeType,
            sizeBytes: lockedSource.sizeBytes.toString(),
          },
        });
        return this.response(
          target,
          { id: lockedFile.id, currentVersionId: versionId },
          version,
          target.capabilities,
        );
      });
    } catch (error) {
      await this.deleteOrphan(storageKey);
      throw error;
    }
  }

  private async availableNodeName(
    parentId: string | null,
    preferredName: string,
    client: DocumentAuthorizationClient,
  ) {
    const existing = await client.node.findMany({
      where: { parentId, trashOperationId: null },
      select: { normalizedName: true },
    });
    const names = new Set(existing.map((node) => node.normalizedName));
    let candidate = normalizeNodeName(preferredName);
    let suffix = 1;
    while (names.has(candidate.normalizedName)) {
      const extensionIndex = preferredName.lastIndexOf('.');
      const stem =
        extensionIndex > 0
          ? preferredName.slice(0, extensionIndex)
          : preferredName;
      const extension =
        extensionIndex > 0 ? preferredName.slice(extensionIndex) : '';
      candidate = normalizeNodeName(`${stem} (${suffix})${extension}`);
      suffix += 1;
    }
    return candidate;
  }

  private async assertInitialDestination(
    actorUserId: string,
    parentId: string | null,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<void> {
    if (parentId === null) {
      const user = await client.user.findUnique({
        where: { id: actorUserId },
        select: { status: true },
      });
      if (user?.status !== UserStatus.ACTIVE) {
        throw new ForbiddenException(
          'Root placement requires an active user',
        );
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

  private async requireEditableFile(
    actorUserId: string,
    nodeId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<VisibleNode & { fileId: string }> {
    const node = await this.requireVisibleNode(
      actorUserId,
      nodeId,
      client,
      true,
    );
    if (node.type !== NodeType.FILE) {
      throw new ConflictException('A folder cannot receive file versions');
    }
    if (!node.fileId) {
      throw new ConflictException('File metadata is unavailable');
    }
    this.requireCapability(node.capabilities, DocumentCapability.EDIT);
    return node as VisibleNode & { fileId: string };
  }

  private async requireVersionedFile(
    actorUserId: string,
    nodeId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<VisibleNode & { fileId: string }> {
    const node = await this.requireVisibleNode(actorUserId, nodeId, client, true);
    if (node.type !== NodeType.FILE) {
      throw new ConflictException('A folder has no file versions');
    }
    if (!node.fileId) {
      throw new ConflictException('File metadata is unavailable');
    }
    return node as VisibleNode & { fileId: string };
  }

  private async requireVisibleNode(
    actorUserId: string,
    nodeId: string,
    client: DocumentAuthorizationClient,
    includeFile = false,
  ): Promise<VisibleNode> {
    const node = await client.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        parentId: true,
        type: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        ...(includeFile ? { file: { select: { id: true, currentVersionId: true } } } : {}),
      },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const resolved = await this.authorization.resolveCapabilities(
      actorUserId,
      nodeId,
      client,
    );
    if (!resolved.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    return {
      ...node,
      ...(includeFile
        ? { fileId: node.file?.id, currentVersionId: node.file?.currentVersionId }
        : {}),
      capabilities: resolved.capabilities,
    };
  }

  private requireCapability(
    capabilities: ReadonlySet<DocumentCapability>,
    capability: DocumentCapability,
  ): void {
    if (!capabilities.has(capability)) {
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    }
  }

  private storageKey(fileId: string, versionId: string): string {
    return `files/${fileId}/versions/${versionId}`;
  }

  private response(
    node: Omit<VisibleNode, 'capabilities'> | VisibleNode,
    file: { id: string; currentVersionId: string },
    version: {
      id: string;
      versionNumber: number;
      originalFilename: string;
      mimeType: string;
      extension: string | null;
      sizeBytes: bigint;
      sha256: string;
      createdAt: Date;
    },
    capabilities: ReadonlySet<DocumentCapability>,
  ): UploadResponse {
    return {
      node: {
        id: node.id,
        parentId: node.parentId,
        type: node.type,
        name: node.name,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        capabilities: Object.values(DocumentCapability).filter((capability) =>
          capabilities.has(capability),
        ),
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

  private async writeAudit(
    transaction: Prisma.TransactionClient,
    input: {
      actorUserId: string;
      action:
        | 'FILE_CREATED'
        | 'FILE_UPLOADED'
        | 'FILE_VERSION_CREATED'
        | 'FILE_VERSION_RESTORED';
      resourceType: 'NODE' | 'FILE_VERSION';
      resourceId: string;
      metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
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

  private async createTextExtractionTask(
    transaction: Prisma.TransactionClient,
    fileVersionId: string,
    mimeType: string,
  ): Promise<void> {
    if (!isSearchableFileMimeType(mimeType)) return;
    await transaction.fileProcessingTask.create({
      data: { fileVersionId, type: FileProcessingTaskType.TEXT_EXTRACTION },
    });
  }

  private async deleteOrphan(storageKey: string): Promise<void> {
    await this.storage.delete(storageKey).catch(() => {
      this.logger.warn('Upload database failure left a storage orphan');
    });
  }

  private throwDomainConflict(error: unknown): void {
    if (this.isUniqueViolation(error)) {
      throw new ConflictException('A node with this name already exists');
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    );
  }

  private isCreationRace(error: unknown): boolean {
    if (this.isUniqueViolation(error)) return true;
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return false;
    }
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

  private assertUuid(value: string, message: string): void {
    if (!isUUID(value)) {
      throw new BadRequestException(message);
    }
  }
}
