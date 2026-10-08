import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  DriveFileLocation,
  DriveSourceStatus,
  DriveUploadOperationStatus,
  DriveFileType,
  FileBackingType,
  NodeType,
  Prisma,
  UserStatus,
} from '@dochub/database';
import Busboy from 'busboy';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { DatabaseService } from '../database/database.service.js';
import { canManageDocuments } from '../common/system-role-policy.js';
import { FileValidationService } from '../files/file-validation.service.js';
import {
  STORAGE_CONFIG,
  type StorageConfig,
} from '../storage/storage.config.js';
import { DriveService, type WritableDriveContext } from './drive.service.js';
import {
  DriveProviderError,
  type DriveApiFile,
} from './google-drive.provider.js';

const MAX_MULTIPART_FIELDS = 1;
const MAX_MULTIPART_PARTS = 3;
const MAX_FIELD_BYTES = 128;
const MAX_IDEMPOTENCY_KEY_BYTES = 200;

interface DriveUploadOperationRecord {
  idempotencyKey: string;
  userId: string;
  parentId: string | null;
  originalFilename: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint | null;
  sha256: string | null;
  status: DriveUploadOperationStatus;
  driveFileId: string | null;
  nodeId: string | null;
  errorMessage: string | null;
}

interface UploadRequest {
  originalFilename: string;
  declaredMimeType: string;
  parentId: string | null;
  file: Readable;
  abortSignal: AbortSignal;
}

@Injectable()
export class DriveUploadService {
  private readonly logger = new Logger(DriveUploadService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly drive: DriveService,
    private readonly validation: FileValidationService,
    @Inject(STORAGE_CONFIG) private readonly storageConfig: StorageConfig,
  ) {}

  async receive(
    userId: string,
    request: Request,
    suppliedIdempotencyKey: string | undefined,
  ) {
    try {
      await this.drive.assertDriveUploadManager(userId);
    } catch (error) {
      request.resume();
      throw error;
    }
    const idempotencyKey = suppliedIdempotencyKey?.trim();
    if (
      !idempotencyKey ||
      Buffer.byteLength(idempotencyKey, 'utf8') > MAX_IDEMPOTENCY_KEY_BYTES
    ) {
      request.resume();
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    }
    if (!request.headers['content-type']?.startsWith('multipart/form-data')) {
      request.resume();
      throw new BadRequestException('Expected multipart/form-data');
    }

    const abortController = new AbortController();
    return new Promise((resolve, reject) => {
      let parser: ReturnType<typeof Busboy>;
      try {
        parser = Busboy({
          headers: request.headers,
          limits: {
            files: 2,
            fields: MAX_MULTIPART_FIELDS,
            parts: MAX_MULTIPART_PARTS,
            fieldSize: MAX_FIELD_BYTES,
            fileSize: this.storageConfig.uploadMaxBytes + 1,
          },
        });
      } catch {
        request.resume();
        reject(new BadRequestException('Malformed multipart request'));
        return;
      }

      let settled = false;
      let fileCount = 0;
      let parentSeen = false;
      let parentId: string | null = null;
      let filePromise: Promise<unknown> | null = null;
      let terminalError: Error | null = null;
      let activeFile: Readable | null = null;

      const fail = (error: Error, abortUpload = true) => {
        terminalError ??= error;
        if (abortUpload && !abortController.signal.aborted)
          abortController.abort();
        request.resume();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        void (async () => {
          try {
            await filePromise;
            if (terminalError) throw terminalError;
            if (fileCount !== 1 || !filePromise) {
              throw new BadRequestException('Exactly one file is required');
            }
          } catch (error) {
            reject(this.requestError(terminalError ?? error));
            return;
          }
          resolve(await filePromise);
        })();
      };

      request.once('aborted', () => {
        fail(new BadRequestException('Upload was aborted'));
        activeFile?.destroy();
      });
      request.once('error', () => {
        fail(new BadRequestException('Upload was aborted'));
        activeFile?.destroy();
      });
      parser.on('field', (name, value, info) => {
        if (
          name !== 'parentId' ||
          info.nameTruncated ||
          info.valueTruncated ||
          parentSeen ||
          fileCount > 0
        ) {
          fail(new BadRequestException('Invalid multipart fields'));
          return;
        }
        parentSeen = true;
        const normalized = value.trim();
        parentId = normalized || null;
        if (parentId !== null && !isUUID(parentId)) {
          fail(new BadRequestException('Invalid parent ID'));
        }
      });
      parser.on('filesLimit', () =>
        fail(new BadRequestException('Exactly one file is required')),
      );
      parser.on('fieldsLimit', () =>
        fail(new BadRequestException('Too many multipart fields')),
      );
      parser.on('partsLimit', () =>
        fail(new BadRequestException('Too many multipart parts')),
      );
      parser.on('error', () =>
        fail(new BadRequestException('Malformed multipart request')),
      );
      parser.once('close', () => {
        if (terminalError) finish();
      });
      parser.on('file', (fieldName, file, info) => {
        fileCount += 1;
        activeFile = file;
        if (
          fieldName !== 'file' ||
          fileCount !== 1 ||
          !info.filename ||
          !parentSeen ||
          terminalError !== null
        ) {
          fail(
            new BadRequestException(
              'A parentId field and exactly one file are required',
            ),
          );
          file.resume();
          return;
        }
        file.once('limit', () =>
          fail(
            new PayloadTooLargeException('File exceeds upload limit'),
            false,
          ),
        );
        filePromise = this.processFile(userId, idempotencyKey, {
          originalFilename: info.filename,
          declaredMimeType: info.mimeType,
          parentId,
          file,
          abortSignal: abortController.signal,
        });
        void filePromise.catch((error: unknown) => {
          fail(this.requestError(error));
          if (!file.destroyed) file.resume();
        });
      });
      parser.once('finish', finish);
      request.pipe(parser);
    });
  }

  private async processFile(
    userId: string,
    idempotencyKey: string,
    upload: UploadRequest,
  ) {
    const validation = this.validation.beginStreamingValidation(
      upload.originalFilename,
      upload.declaredMimeType,
      this.storageConfig.uploadMaxBytes,
    );
    const existing = await this.database.prisma.driveUploadOperation.findUnique(
      {
        where: { idempotencyKey },
      },
    );
    if (existing) {
      await this.assertSameRequest(existing, userId, upload, validation);
      if (existing.status === DriveUploadOperationStatus.SUCCEEDED) {
        const metadata = await this.validateAndDrain(upload.file, validation);
        if (
          metadata.sizeBytes !== existing.sizeBytes ||
          metadata.sha256 !== existing.sha256
        ) {
          throw new ConflictException(
            'The Idempotency-Key was already used for a different upload',
          );
        }
        return this.operationResponse(existing.nodeId);
      }
      if (existing.status === DriveUploadOperationStatus.IN_PROGRESS) {
        throw new ConflictException('This Drive upload is already in progress');
      }
      throw new ConflictException(
        existing.errorMessage ?? 'This Drive upload has already failed',
      );
    }

    return this.drive.withWritableDrive(userId, async (context) => {
      const claimed = await this.beginOperation(
        userId,
        idempotencyKey,
        upload.parentId,
        validation.originalFilename,
        validation.nodeName,
        validation.mimeType,
      );
      const operation = claimed.operation;
      if (operation.userId !== userId) {
        throw new ConflictException('The Idempotency-Key is already in use');
      }
      if (!claimed.isNew) {
        if (operation.status === DriveUploadOperationStatus.SUCCEEDED) {
          await this.assertSameRequest(operation, userId, upload, validation);
          const metadata = await this.validateAndDrain(upload.file, validation);
          if (
            metadata.sizeBytes !== operation.sizeBytes ||
            metadata.sha256 !== operation.sha256
          ) {
            throw new ConflictException(
              'The Idempotency-Key was already used for a different upload',
            );
          }
          return this.operationResponse(operation.nodeId);
        }
        throw new ConflictException(
          operation.errorMessage ?? 'This Drive upload has already failed',
        );
      }
      if (
        operation.originalFilename !== validation.originalFilename ||
        operation.parentId !== upload.parentId ||
        operation.mimeType !== validation.mimeType
      ) {
        throw new ConflictException('The Idempotency-Key is already in use');
      }

      let remoteFile: DriveApiFile | undefined;
      const transfer = finished(validation.stream, { readable: false });
      void transfer.catch(() => undefined);
      upload.file.pipe(validation.stream);
      try {
        remoteFile = await this.drive.uploadBinaryWithContext(
          context,
          operation.name,
          validation.mimeType,
          validation.stream,
          upload.abortSignal,
        );
        await transfer;
        const metadata = await validation.finish();
        await this.database.prisma.driveUploadOperation.update({
          where: { idempotencyKey },
          data: {
            driveFileId: remoteFile.id,
            sizeBytes: metadata.sizeBytes,
            sha256: metadata.sha256,
          },
        });
        return await this.registerUpload(
          context,
          operation,
          remoteFile,
          metadata.sizeBytes,
          metadata.sha256,
        );
      } catch (error) {
        upload.file.unpipe(validation.stream);
        validation.stream.destroy();
        if (!upload.file.destroyed) upload.file.resume();
        await transfer.catch(() => undefined);
        if (remoteFile?.id) {
          await this.compensate(context, operation, remoteFile.id, error);
        } else {
          await this.markFailed(idempotencyKey, this.safeFailure(error));
        }
        if (this.isExpectedUploadError(error)) throw error;
        if (error instanceof DriveProviderError) {
          throw new ServiceUnavailableException('Google Drive upload failed.');
        }
        throw new ServiceUnavailableException(
          'Google Drive upload could not be completed.',
        );
      }
    });
  }

  private async validateAndDrain(
    file: Readable,
    validation: ReturnType<FileValidationService['beginStreamingValidation']>,
  ) {
    const transfer = finished(validation.stream, { readable: false });
    file.pipe(validation.stream);
    try {
      await transfer;
      return await validation.finish();
    } catch (error) {
      file.unpipe(validation.stream);
      validation.stream.destroy();
      if (!file.destroyed) file.resume();
      await transfer.catch(() => undefined);
      throw error;
    }
  }

  private async beginOperation(
    userId: string,
    idempotencyKey: string,
    parentId: string | null,
    originalFilename: string,
    baseName: string,
    mimeType: string,
  ): Promise<{ operation: DriveUploadOperationRecord; isNew: boolean }> {
    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        const existing = await transaction.driveUploadOperation.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return { operation: existing, isNew: false };
        await this.assertLogicalParent(transaction, parentId);
        const name = await this.nextAvailableName(
          transaction,
          parentId,
          baseName,
        );
        const operation = await transaction.driveUploadOperation.create({
          data: {
            idempotencyKey,
            userId,
            parentId,
            originalFilename,
            name,
            mimeType,
          },
        });
        return { operation, isNew: true };
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      ) {
        throw error;
      }
      const existing =
        await this.database.prisma.driveUploadOperation.findUnique({
          where: { idempotencyKey },
        });
      if (!existing) throw error;
      return { operation: existing, isNew: false };
    }
  }

  private async registerUpload(
    context: WritableDriveContext,
    operation: DriveUploadOperationRecord,
    remoteFile: DriveApiFile,
    sizeBytes: bigint,
    sha256: string,
  ) {
    const parentId = operation.parentId;
    const remoteName = remoteFile.name?.trim() || operation.name;
    const name = operation.name;
    const normalizedName = name.trim().normalize('NFC').toLowerCase();
    const storedDriveFileData = this.driveFileData(
      context.connectionId,
      { ...remoteFile, name: remoteName, mimeType: operation.mimeType },
      sizeBytes,
    );
    const result = await this.database.prisma.$transaction(
      async (transaction) => {
        const actor = await transaction.user.findUnique({
          where: { id: operation.userId },
          select: { status: true, systemRole: true },
        });
        if (
          !actor ||
          actor.status !== UserStatus.ACTIVE ||
          !canManageDocuments(actor.systemRole)
        ) {
          throw new ForbiddenException(
            'Document-management access is required',
          );
        }
        await this.assertLogicalParent(transaction, parentId);
        const conflict = await transaction.node.findFirst({
          where: {
            parentId,
            normalizedName,
            trashOperationId: null,
          },
          select: { id: true },
        });
        if (conflict) {
          throw new ConflictException('A node with this name already exists');
        }
        const storedDriveFile = await transaction.driveFile.upsert({
          where: {
            driveConnectionId_driveFileId: {
              driveConnectionId: context.connectionId,
              driveFileId: remoteFile.id,
            },
          },
          create: storedDriveFileData,
          update: storedDriveFileData,
          select: { id: true },
        });
        const node = await transaction.node.create({
          data: {
            parentId,
            type: NodeType.FILE,
            name,
            normalizedName,
            createdById: operation.userId,
            updatedById: operation.userId,
          },
          select: { id: true, parentId: true, name: true },
        });
        await transaction.file.create({
          data: {
            nodeId: node.id,
            backingType: FileBackingType.GOOGLE_DRIVE,
            driveFileId: storedDriveFile.id,
          },
        });
        await transaction.driveUploadOperation.update({
          where: { idempotencyKey: operation.idempotencyKey },
          data: {
            status: DriveUploadOperationStatus.SUCCEEDED,
            driveFileId: remoteFile.id,
            nodeId: node.id,
            sizeBytes,
            sha256,
            errorMessage: null,
          },
        });
        await transaction.auditLog.create({
          data: {
            actorType: AuditActorType.USER,
            actorId: operation.userId,
            action: 'GOOGLE_DRIVE_FILE_UPLOADED',
            resourceType: 'NODE',
            resourceId: node.id,
            result: AuditResult.SUCCESS,
            metadata: {
              nodeId: node.id,
              driveFileId: storedDriveFile.id,
              mimeType: operation.mimeType,
              sizeBytes: sizeBytes.toString(),
              parentId,
            },
          },
        });
        return { node };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return result;
  }

  private async compensate(
    context: WritableDriveContext,
    operation: Pick<DriveUploadOperationRecord, 'idempotencyKey' | 'userId'>,
    driveFileId: string,
    cause: unknown,
  ) {
    try {
      await this.drive.deleteBinaryWithContext(context, driveFileId);
      await this.markFailed(
        operation.idempotencyKey,
        'Upload registration failed; the Google Drive file was removed.',
        driveFileId,
      );
    } catch (compensationError) {
      const errorMessage =
        'Google Drive created a file that Docs Hub could not register; manual reconciliation is required.';
      await this.markFailed(
        operation.idempotencyKey,
        errorMessage,
        driveFileId,
      );
      await this.database.prisma.auditLog.create({
        data: {
          actorType: AuditActorType.USER,
          actorId: operation.userId,
          action: 'GOOGLE_DRIVE_FILE_ORPHANED',
          resourceType: 'DRIVE_UPLOAD',
          resourceId: null,
          result: AuditResult.FAILED,
          metadata: {
            driveFileId,
            error: this.safeFailure(cause),
            compensationError: this.safeFailure(compensationError),
          },
        },
      });
      this.logger.error(
        'Drive upload requires reconciliation for a remote file.',
      );
      throw new ServiceUnavailableException(
        `Google Drive created a file that Docs Hub could not register. Reconcile Drive file ${driveFileId}.`,
      );
    }
    throw new ServiceUnavailableException(
      'Upload could not be registered; the Google Drive file was removed.',
    );
  }

  private async markFailed(
    idempotencyKey: string,
    errorMessage: string,
    driveFileId?: string,
  ) {
    await this.database.prisma.driveUploadOperation.updateMany({
      where: {
        idempotencyKey,
        status: DriveUploadOperationStatus.IN_PROGRESS,
      },
      data: {
        status: DriveUploadOperationStatus.FAILED,
        errorMessage,
        ...(driveFileId ? { driveFileId } : {}),
      },
    });
  }

  private async operationResponse(nodeId: string | null) {
    if (!nodeId) {
      throw new ConflictException('Drive upload operation is not complete');
    }
    const node = await this.database.prisma.node.findUnique({
      where: { id: nodeId },
      select: { id: true, parentId: true, name: true },
    });
    if (!node)
      throw new ConflictException('Drive upload operation is not complete');
    return { node };
  }

  private async assertSameRequest(
    operation: {
      userId: string;
      parentId: string | null;
      originalFilename: string;
      mimeType: string;
    },
    userId: string,
    upload: UploadRequest,
    validation: ReturnType<FileValidationService['beginStreamingValidation']>,
  ) {
    if (
      operation.userId !== userId ||
      operation.parentId !== upload.parentId ||
      operation.originalFilename !== validation.originalFilename ||
      operation.mimeType !== validation.mimeType
    ) {
      throw new ConflictException('The Idempotency-Key is already in use');
    }
  }

  private async assertLogicalParent(
    client: Prisma.TransactionClient,
    parentId: string | null,
  ) {
    if (parentId === null) return;
    const parent = await client.node.findFirst({
      where: { id: parentId, type: NodeType.FOLDER, trashOperationId: null },
      select: { id: true },
    });
    if (!parent) throw new BadRequestException('Destination folder not found');
  }

  private async nextAvailableName(
    client: Prisma.TransactionClient,
    parentId: string | null,
    baseName: string,
  ) {
    const existing = await client.node.findMany({
      where: { parentId, trashOperationId: null },
      select: { normalizedName: true },
    });
    const names = new Set(existing.map((node) => node.normalizedName));
    let name = baseName;
    let normalized = name.toLowerCase();
    let suffix = 1;
    while (names.has(normalized)) {
      const extensionIndex = baseName.lastIndexOf('.');
      const stem =
        extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName;
      const extension =
        extensionIndex > 0 ? baseName.slice(extensionIndex) : '';
      name = `${stem} (${suffix})${extension}`;
      normalized = name.toLowerCase();
      suffix += 1;
      if (suffix > 1000) {
        throw new ConflictException('Unable to allocate a unique upload name');
      }
    }
    return name;
  }

  private driveFileData(
    connectionId: string,
    file: DriveApiFile,
    sizeBytes: bigint,
  ): Prisma.DriveFileUncheckedCreateInput {
    const mimeType = file.mimeType ?? 'application/octet-stream';
    return {
      driveConnectionId: connectionId,
      driveFileId: file.id,
      name: file.name?.trim() || '(unnamed Drive file)',
      mimeType,
      normalizedType: this.normalizeType(mimeType),
      webViewLink: file.webViewLink ?? null,
      driveModifiedTime: this.safeDate(file.modifiedTime),
      driveCreatedTime: this.safeDate(file.createdTime),
      trashed: file.trashed === true,
      driveParents: file.parents ?? [],
      location: file.driveId
        ? DriveFileLocation.SHARED_DRIVE
        : DriveFileLocation.MY_DRIVE,
      sharedDriveId: file.driveId ?? null,
      sizeBytes: file.size ? this.safeBigInt(file.size) : sizeBytes,
      driveVersion: file.version ?? null,
      sourceStatus: file.trashed
        ? DriveSourceStatus.UNAVAILABLE
        : DriveSourceStatus.CONNECTED,
      syncedAt: new Date(),
    };
  }

  private normalizeType(mimeType: string): DriveFileType {
    switch (mimeType) {
      case 'application/pdf':
        return DriveFileType.PDF;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return DriveFileType.DOCX;
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return DriveFileType.XLSX;
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return DriveFileType.PPTX;
      default:
        if (mimeType.startsWith('image/')) return DriveFileType.IMAGE;
        if (mimeType.startsWith('video/')) return DriveFileType.VIDEO;
        return DriveFileType.BINARY;
    }
  }

  private safeDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private safeBigInt(value: string): bigint | null {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private isExpectedUploadError(error: unknown): boolean {
    return (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof PayloadTooLargeException ||
      error instanceof UnsupportedMediaTypeException ||
      error instanceof ServiceUnavailableException
    );
  }

  private requestError(error: unknown): Error {
    if (
      error instanceof BadRequestException ||
      error instanceof ConflictException ||
      error instanceof ForbiddenException ||
      error instanceof PayloadTooLargeException ||
      error instanceof UnsupportedMediaTypeException ||
      error instanceof ServiceUnavailableException
    ) {
      return error;
    }
    if (error instanceof DriveProviderError) {
      return new ServiceUnavailableException('Google Drive upload failed.');
    }
    return new BadRequestException('Malformed multipart request');
  }

  private safeFailure(error: unknown): string {
    if (error instanceof DriveProviderError) {
      switch (error.kind) {
        case 'unauthorized':
          return 'Google Drive authorization expired or was revoked.';
        case 'forbidden':
          return 'Google Drive denied the upload.';
        case 'rate_limited':
          return 'Google Drive is temporarily rate-limiting uploads.';
        case 'network':
          return 'Google Drive could not be reached during upload.';
        default:
          return 'Google Drive returned an unexpected upload error.';
      }
    }
    return 'Docs Hub could not complete the Google Drive upload.';
  }
}
