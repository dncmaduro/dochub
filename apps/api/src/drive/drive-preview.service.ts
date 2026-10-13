import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FileBackingType, UserStatus } from '@dochub/database';
import contentDisposition from 'content-disposition';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { DriveService } from './drive.service.js';
import { FileEngineRegistry } from '../file-engine/file-engine.registry.js';
import { isDocxFile, isExpectedDocxFailure } from '../file-engine/engines/document.engine.js';
import { isPptxFile } from '../file-engine/engines/presentation.engine.js';
import {
  extensionFromFilename,
  type FileDescriptor,
  type FileEngineId,
  type FilePreviewContent,
  type FilePreviewResult,
} from '../file-engine/file-engine.types.js';
import { STORAGE_PROVIDER } from '../storage/storage-provider.js';
import type {
  StorageObjectRef,
  StorageProvider,
  StorageReadResult,
} from '../storage/storage-provider.js';
import { parseSingleByteRange } from '../files/byte-range.js';
import { DocxPackageError } from '../file-engine/document/docx-package-reader.js';
import { DocumentEditValidationError, parseDocumentPatchRequest } from '../file-engine/document/document-edit.types.js';
import { StorageConflictError } from '../storage/storage.errors.js';
import { isCsvFile, isXlsxFile } from '../file-engine/engines/spreadsheet.engine.js';
import { SpreadsheetEditValidationError, parseSpreadsheetPatchRequest } from '../file-engine/spreadsheet/spreadsheet-edit.types.js';
import { SpreadsheetPackageError } from '../file-engine/spreadsheet/xlsx-package-reader.js';
import { PresentationEditValidationError, parsePresentationPatchRequest } from '../file-engine/presentation/presentation-edit.types.js';
import { PresentationPackageError } from '../file-engine/presentation/pptx-package-reader.js';
import { isExpectedTextFailure, isTextFile } from '../file-engine/engines/text.engine.js';
import { TextEditValidationError, parseTextPatchRequest } from '../file-engine/text/text-edit.types.js';
import { TextSourceError } from '../file-engine/text/text-source.js';

const DRIVE_PREVIEW_AUDIENCE = 'dochub-drive-preview';
const DRIVE_PREVIEW_TTL_SECONDS = 300;
const PREVIEW_PDF_MIME_TYPE = 'application/pdf';
const LIBREOFFICE_TIMEOUT_MS = 30_000;
const MAX_OFFICE_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_OFFICE_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_CONVERTER_OUTPUT_BYTES = 8 * 1024;

type DrivePreviewKind = 'direct' | 'google-export' | 'office' | 'document' | 'spreadsheet' | 'presentation' | 'text';

type DrivePreviewToken = {
  typ: 'drive-preview';
  sid: string;
  sub: string;
  nid: string;
  did: string;
  mimeType: string;
  filename: string;
  kind?: DrivePreviewKind;
  officeExtension?: string;
  engineId?: FileEngineId;
  sourceMimeType?: string | null;
  extension?: string | null;
};

type PreviewContent = FilePreviewContent;

function previewRef(preview: Pick<DrivePreviewToken, 'did'>): StorageObjectRef {
  return { provider: 'GOOGLE_DRIVE', objectId: preview.did };
}

function previewContent(content: StorageReadResult): PreviewContent {
  return {
    stream: content.stream,
    mimeType: content.metadata.mimeType,
    sizeBytes: content.metadata.sizeBytes,
    range: content.range,
    cleanup: content.cleanup,
  };
}

export type DrivePreviewSession = {
  previewable: boolean;
  sessionId: string;
  nodeId: string;
  token: string;
  contentUrl: string;
  expiresAt: string;
  mimeType: string;
  filename: string;
  size: string;
  engine: FileEngineId;
  capabilities: ReturnType<FileEngineRegistry['resolve']>['capabilities'];
  preview: FilePreviewResult;
  modelUrl?: string;
  storageRevision?: string;
};

function safePreviewError(): ServiceUnavailableException {
  return new ServiceUnavailableException('Preview is unavailable.');
}

@Injectable()
export class DrivePreviewService {
  private readonly logger = new Logger(DrivePreviewService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly jwt: JwtService,
    private readonly drive: DriveService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Optional() private readonly injectedRegistry?: FileEngineRegistry,
  ) {}

  private get registry(): FileEngineRegistry {
    return this.injectedRegistry ?? new FileEngineRegistry();
  }

  cookieName(sessionId: string): string {
    return `dochub_drive_preview_${sessionId}`;
  }

  async create(userId: string, nodeId: string): Promise<DrivePreviewSession | null> {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    if (!capabilities.capabilities.has(DocumentCapability.PREVIEW)) {
      if (capabilities.capabilities.has(DocumentCapability.DOWNLOAD)) return null;
      throw new ForbiddenException('You do not have the required document capability');
    }
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        name: true,
        type: true,
        file: {
          select: {
            backingType: true,
            id: true,
            driveFile: {
              select: {
                driveFileId: true,
                mimeType: true,
                sizeBytes: true,
                sourceStatus: true,
                trashed: true,
              },
            },
          },
        },
      },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE
      ? node.file.driveFile
      : null;
    if (!node || node.type !== 'FILE' || !source) throw new NotFoundException('Node not found');
    if (source.trashed || source.sourceStatus === 'UNAVAILABLE') {
      throw new ServiceUnavailableException('Google Drive source is unavailable');
    }
    const descriptor: FileDescriptor = {
      fileId: node.file?.id ?? node.id,
      nodeId: node.id,
      name: node.name,
      mimeType: source.mimeType,
      extension: extensionFromFilename(node.name),
      size: source.sizeBytes === null ? null : Number(source.sizeBytes),
      storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId },
    };
    const resolved = this.registry.resolve(descriptor);
    let preview = await resolved.engine.openPreview(descriptor);
    if (resolved.engine.id === 'DOCUMENT' && isDocxFile(descriptor)) {
      try {
        await resolved.engine.openModel?.(descriptor, { storage: this.storage });
      } catch (error) {
        if (!isExpectedDocxFailure(error)) {
          this.logger.error(`Native DOCX preview failed unexpectedly (${this.safeErrorKind(error)})`);
          throw safePreviewError();
        }
        this.logger.warn(`Native DOCX preview fallback (${this.safeErrorKind(error)})`);
        preview = { kind: 'pdf', mimeType: PREVIEW_PDF_MIME_TYPE, reason: 'failed' };
      }
    }
    if (resolved.engine.id === 'SPREADSHEET' && (isXlsxFile(descriptor) || isCsvFile(descriptor))) {
      try {
        await resolved.engine.openModel?.(descriptor, { storage: this.storage });
      } catch (error) {
        if (!(error instanceof SpreadsheetPackageError)) {
          this.logger.error(`Native spreadsheet preview failed unexpectedly (${this.safeErrorKind(error)})`);
          throw safePreviewError();
        }
        this.logger.warn(`Native spreadsheet preview unavailable (${this.safeErrorKind(error)})`);
        preview = { kind: 'unavailable', mimeType: source.mimeType, reason: 'failed' };
      }
    }
    if (resolved.engine.id === 'PRESENTATION' && isPptxFile(descriptor)) {
      try {
        await resolved.engine.openModel?.(descriptor, { storage: this.storage });
      } catch (error) {
        if (!(error instanceof PresentationPackageError)) {
          this.logger.error(`Native presentation preview failed unexpectedly (${this.safeErrorKind(error)})`);
          throw safePreviewError();
        }
        this.logger.warn(`Native presentation preview unavailable (${this.safeErrorKind(error)})`);
        preview = { kind: 'unavailable', mimeType: source.mimeType, reason: 'failed' };
      }
    }
    if (resolved.engine.id === 'TEXT' && isTextFile(descriptor)) {
      try {
        await resolved.engine.openModel?.(descriptor, { storage: this.storage });
      } catch (error) {
        if (!isExpectedTextFailure(error)) {
          this.logger.error(`Native text preview failed unexpectedly (${this.safeErrorKind(error)})`);
          throw safePreviewError();
        }
        this.logger.warn(`Native text preview unavailable (${this.safeErrorKind(error)})`);
        preview = { kind: 'unavailable', mimeType: source.mimeType, reason: 'failed' };
      }
    }
    const plan = preview.kind === 'unavailable'
      ? null
      : resolved.engine.id === 'LEGACY_GOOGLE_NATIVE'
        ? { kind: 'google-export' as const }
        : preview.kind === 'document'
          ? { kind: 'document' as const }
        : preview.kind === 'spreadsheet'
          ? { kind: 'spreadsheet' as const }
        : preview.kind === 'presentation'
          ? { kind: 'presentation' as const }
        : preview.kind === 'text'
          ? { kind: 'text' as const }
        : preview.kind === 'pdf' && ['DOCUMENT', 'SPREADSHEET', 'PRESENTATION'].includes(resolved.engine.id)
          ? { kind: 'office' as const }
          : { kind: 'direct' as const };
    if (!plan && !capabilities.capabilities.has(DocumentCapability.DOWNLOAD)) return null;
    await this.drive.assertReadableDrive();
    const publicCapabilities = {
      ...resolved.capabilities,
      edit: resolved.capabilities.edit && capabilities.capabilities.has(DocumentCapability.EDIT),
    };
    const storageRevision = plan?.kind === 'document' || plan?.kind === 'spreadsheet' || plan?.kind === 'presentation' || plan?.kind === 'text'
      ? (await this.storage.stat(previewRef({ did: source.driveFileId }))).revision
      : undefined;
    const outputMimeType = preview.mimeType ?? source.mimeType.toLowerCase();
    const sessionId = randomUUID();
    const token = await this.jwt.signAsync<DrivePreviewToken>(
      {
        typ: 'drive-preview',
        sid: sessionId,
        sub: userId,
        nid: node.id,
        did: source.driveFileId,
        mimeType: outputMimeType,
        filename: node.name,
        ...(plan ? { kind: plan.kind } : {}),
        ...(plan?.kind === 'office' ? { officeExtension: descriptor.extension ?? undefined } : {}),
        engineId: resolved.engine.id,
        sourceMimeType: descriptor.mimeType,
        extension: descriptor.extension,
      },
      { expiresIn: DRIVE_PREVIEW_TTL_SECONDS, audience: DRIVE_PREVIEW_AUDIENCE },
    );
    return {
      previewable: Boolean(plan),
      sessionId,
      nodeId: node.id,
      token,
      contentUrl: `/drive-preview/${sessionId}/content`,
      expiresAt: new Date(Date.now() + DRIVE_PREVIEW_TTL_SECONDS * 1000).toISOString(),
      mimeType: outputMimeType,
      filename: node.name,
      size: source.sizeBytes?.toString() ?? '0',
      engine: resolved.engine.id,
      capabilities: publicCapabilities,
      preview,
      ...(plan?.kind === 'document' || plan?.kind === 'spreadsheet' || plan?.kind === 'presentation' || plan?.kind === 'text' ? { modelUrl: `/drive-preview/${sessionId}/content/model` } : {}),
      ...(storageRevision ? { storageRevision } : {}),
    };
  }

  async verify(sessionId: string, token: string | undefined): Promise<DrivePreviewToken> {
    if (!token) throw new UnauthorizedException('Drive preview session is invalid');
    let preview: DrivePreviewToken;
    try {
      preview = await this.jwt.verifyAsync<DrivePreviewToken>(token, {
        audience: DRIVE_PREVIEW_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException('Drive preview session is invalid');
    }
    if (
      preview.typ !== 'drive-preview' ||
      preview.sid !== sessionId ||
      !preview.nid ||
      !preview.did ||
      !preview.mimeType
    ) {
      throw new UnauthorizedException('Drive preview session is invalid');
    }
    const user = await this.database.prisma.user.findUnique({
      where: { id: preview.sub },
      select: { status: true },
    });
    if (user?.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Drive preview session is invalid');
    }
    const capabilities = await this.authorization.resolveCapabilities(preview.sub, preview.nid);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW) || !capabilities.capabilities.has(DocumentCapability.PREVIEW)) {
      throw new ForbiddenException('Drive preview access was revoked');
    }
    const node = await this.database.prisma.node.findFirst({
      where: {
        id: preview.nid,
        type: 'FILE',
        trashOperationId: null,
        file: {
          backingType: FileBackingType.GOOGLE_DRIVE,
          driveFile: {
            driveFileId: preview.did,
            trashed: false,
            sourceStatus: { not: 'UNAVAILABLE' },
          },
        },
      },
      select: { id: true },
    });
    if (!node) throw new NotFoundException('Drive preview is unavailable');
    return preview;
  }

  async openContent(preview: DrivePreviewToken, rangeHeader?: string): Promise<PreviewContent> {
    if (preview.kind === 'google-export') {
      return this.drive.openPreviewExport(preview.did, PREVIEW_PDF_MIME_TYPE);
    }
    if (preview.kind === 'office' && !preview.engineId) {
      return this.convertOfficePreview(
        previewRef(preview),
        preview.officeExtension,
      );
    }
    const reference = previewRef(preview);
    if (preview.kind === 'document') {
      let range = null;
      if (rangeHeader) {
        const current = await this.storage.stat(reference);
        if (current.sizeBytes === null) throw safePreviewError();
        range = parseSingleByteRange(rangeHeader, current.sizeBytes);
      }
      return previewContent(await this.storage.openRead(reference, range ? { range } : undefined));
    }
    const descriptor: FileDescriptor = {
      fileId: preview.did,
      nodeId: preview.nid,
      name: preview.filename,
      mimeType: preview.sourceMimeType ?? preview.mimeType,
      extension: preview.extension ?? extensionFromFilename(preview.filename),
      size: null,
      storageRef: reference,
    };
    const engine = preview.engineId
      ? this.registry.get(preview.engineId)
      : this.registry.resolve(descriptor).engine;
    let range = null;
    if (rangeHeader && preview.kind !== 'office') {
      const current = await this.storage.stat(reference);
      if (current.sizeBytes === null) throw safePreviewError();
      range = parseSingleByteRange(rangeHeader, current.sizeBytes);
    }
    if (!engine.openContent) throw safePreviewError();
    return engine.openContent(descriptor, {
      storage: this.storage,
      range: range ?? undefined,
      forceLibreOfficePreview: preview.kind === 'office',
      openLibreOfficePreview: (file) => this.convertOfficePreview(
        file.storageRef ?? reference,
        file.extension ?? preview.officeExtension,
      ),
      openLegacyGoogleNativePreview: () => this.drive.openPreviewExport(
        preview.did,
        PREVIEW_PDF_MIME_TYPE,
      ),
    });
  }

  async openModel(preview: DrivePreviewToken) {
    if (preview.kind !== 'document' && preview.kind !== 'spreadsheet' && preview.kind !== 'presentation' && preview.kind !== 'text') throw safePreviewError();
    const descriptor = this.descriptor(preview);
    const engine = preview.engineId ? this.registry.get(preview.engineId) : this.registry.resolve(descriptor).engine;
    if (!engine.openModel) throw safePreviewError();
    const current = await this.storage.stat(previewRef(preview));
    return engine.openModel(descriptor, {
      storage: this.storage,
      assetUrl: (assetId) => `/drive-preview/${preview.sid}/content/assets/${encodeURIComponent(assetId)}`,
      storageRevision: current.revision,
    });
  }

  async openSheet(preview: DrivePreviewToken, sheetId: string) {
    if (preview.kind !== 'spreadsheet' || !/^[A-Za-z0-9_-]{1,200}$/u.test(sheetId)) throw safePreviewError();
    const descriptor = this.descriptor(preview);
    const engine = preview.engineId ? this.registry.get(preview.engineId) : this.registry.resolve(descriptor).engine;
    if (!engine.openSheet) throw safePreviewError();
    const current = await this.storage.stat(previewRef(preview));
    return engine.openSheet(descriptor, sheetId, { storage: this.storage, storageRevision: current.revision });
  }

  async openSlide(preview: DrivePreviewToken, slideId: string) {
    if (preview.kind !== 'presentation' || !/^[A-Za-z0-9_-]{1,200}$/u.test(slideId)) throw safePreviewError();
    const descriptor = this.descriptor(preview);
    const engine = preview.engineId ? this.registry.get(preview.engineId) : this.registry.resolve(descriptor).engine;
    if (!engine.openSlide) throw safePreviewError();
    const current = await this.storage.stat(previewRef(preview));
    return engine.openSlide(descriptor, slideId, { storage: this.storage, assetUrl: (assetId) => `/drive-preview/${preview.sid}/content/assets/${encodeURIComponent(assetId)}`, storageRevision: current.revision });
  }

  async openAsset(preview: DrivePreviewToken, assetId: string): Promise<PreviewContent> {
    if ((preview.kind !== 'document' && preview.kind !== 'presentation') || !/^[A-Za-z0-9_-]{1,200}$/u.test(assetId)) throw safePreviewError();
    const descriptor = this.descriptor(preview);
    const engine = preview.engineId ? this.registry.get(preview.engineId) : this.registry.resolve(descriptor).engine;
    if (!engine.openAsset) throw safePreviewError();
    return engine.openAsset(descriptor, assetId, { storage: this.storage });
  }

  async saveDocument(userId: string, nodeId: string, body: unknown) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.EDIT)) {
      throw new ForbiddenException('You do not have the required document capability');
    }
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        name: true,
        type: true,
        file: {
          select: {
            backingType: true,
            id: true,
            driveFile: {
              select: {
                driveFileId: true,
                mimeType: true,
                sizeBytes: true,
                sourceStatus: true,
                trashed: true,
              },
            },
          },
        },
      },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE ? node.file.driveFile : null;
    if (!node || node.type !== 'FILE' || !source || source.trashed || source.sourceStatus === 'UNAVAILABLE') {
      throw new NotFoundException('Node not found');
    }
    const descriptor: FileDescriptor = {
      fileId: node.file?.id ?? node.id,
      nodeId: node.id,
      name: node.name,
      mimeType: source.mimeType,
      extension: extensionFromFilename(node.name),
      size: source.sizeBytes === null ? null : Number(source.sizeBytes),
      storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId },
    };
    const resolved = this.registry.resolve(descriptor);
    if (resolved.engine.id !== 'DOCUMENT' || !isDocxFile(descriptor) || !resolved.capabilities.edit || !resolved.engine.save) {
      throw new BadRequestException('This file is not editable as a native DOCX document');
    }
    try {
      const request = parseDocumentPatchRequest(body);
      return await resolved.engine.save(descriptor, request, { storage: this.storage, expectedRevision: request.expectedRevision });
    } catch (error) {
      if (error instanceof StorageConflictError) throw new ConflictException('This file changed after you opened it.');
      if (error instanceof DocxPackageError || error instanceof DocumentEditValidationError || error instanceof BadRequestException) {
        throw new BadRequestException('The document changes are invalid.');
      }
      throw error;
    }
  }

  async saveSpreadsheet(userId: string, nodeId: string, body: unknown) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.EDIT)) throw new ForbiddenException('You do not have the required document capability');
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { id: true, name: true, type: true, file: { select: { backingType: true, id: true, driveFile: { select: { driveFileId: true, mimeType: true, sizeBytes: true, sourceStatus: true, trashed: true } } } } },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE ? node.file.driveFile : null;
    if (!node || node.type !== 'FILE' || !source || source.trashed || source.sourceStatus === 'UNAVAILABLE') throw new NotFoundException('Node not found');
    const descriptor: FileDescriptor = { fileId: node.file?.id ?? node.id, nodeId: node.id, name: node.name, mimeType: source.mimeType, extension: extensionFromFilename(node.name), size: source.sizeBytes === null ? null : Number(source.sizeBytes), storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId } };
    const resolved = this.registry.resolve(descriptor);
    if (resolved.engine.id !== 'SPREADSHEET' || (!isXlsxFile(descriptor) && !isCsvFile(descriptor)) || !resolved.capabilities.edit || !resolved.engine.save) throw new BadRequestException('This file is not editable as a native XLSX or CSV spreadsheet');
    try {
      const request = parseSpreadsheetPatchRequest(body);
      return await resolved.engine.save(descriptor, request, { storage: this.storage, expectedRevision: request.expectedRevision });
    } catch (error) {
      if (error instanceof StorageConflictError) throw new ConflictException('This file changed after you opened it.');
      if (error instanceof SpreadsheetPackageError || error instanceof SpreadsheetEditValidationError || error instanceof BadRequestException) throw new BadRequestException('The spreadsheet changes are invalid.');
      throw error;
    }
  }

  async savePresentation(userId: string, nodeId: string, body: unknown) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.EDIT)) throw new ForbiddenException('You do not have the required document capability');
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { id: true, name: true, type: true, file: { select: { backingType: true, id: true, driveFile: { select: { driveFileId: true, mimeType: true, sizeBytes: true, sourceStatus: true, trashed: true } } } } },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE ? node.file.driveFile : null;
    if (!node || node.type !== 'FILE' || !source || source.trashed || source.sourceStatus === 'UNAVAILABLE') throw new NotFoundException('Node not found');
    const descriptor: FileDescriptor = { fileId: node.file?.id ?? node.id, nodeId: node.id, name: node.name, mimeType: source.mimeType, extension: extensionFromFilename(node.name), size: source.sizeBytes === null ? null : Number(source.sizeBytes), storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId } };
    const resolved = this.registry.resolve(descriptor);
    if (resolved.engine.id !== 'PRESENTATION' || !isPptxFile(descriptor) || !resolved.capabilities.edit || !resolved.engine.save) throw new BadRequestException('This file is not editable as a native PPTX presentation');
    try {
      const request = parsePresentationPatchRequest(body);
      return await resolved.engine.save(descriptor, request, { storage: this.storage, expectedRevision: request.expectedRevision });
    } catch (error) {
      if (error instanceof StorageConflictError) throw new ConflictException('This file changed after you opened it.');
      if (error instanceof PresentationPackageError || error instanceof PresentationEditValidationError || error instanceof BadRequestException) throw new BadRequestException('The presentation changes are invalid.');
      throw error;
    }
  }

  async saveText(userId: string, nodeId: string, body: unknown) {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.EDIT)) throw new ForbiddenException('You do not have the required document capability');
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { id: true, name: true, type: true, file: { select: { backingType: true, id: true, driveFile: { select: { driveFileId: true, mimeType: true, sizeBytes: true, sourceStatus: true, trashed: true } } } } },
    });
    const source = node?.file?.backingType === FileBackingType.GOOGLE_DRIVE ? node.file.driveFile : null;
    if (!node || node.type !== 'FILE' || !source || source.trashed || source.sourceStatus === 'UNAVAILABLE') throw new NotFoundException('Node not found');
    const descriptor: FileDescriptor = { fileId: node.file?.id ?? node.id, nodeId: node.id, name: node.name, mimeType: source.mimeType, extension: extensionFromFilename(node.name), size: source.sizeBytes === null ? null : Number(source.sizeBytes), storageRef: { provider: 'GOOGLE_DRIVE', objectId: source.driveFileId } };
    const resolved = this.registry.resolve(descriptor);
    if (resolved.engine.id !== 'TEXT' || !isTextFile(descriptor) || !resolved.capabilities.edit || !resolved.engine.save) throw new BadRequestException('This file is not editable as native text');
    try {
      const request = parseTextPatchRequest(body);
      return await resolved.engine.save(descriptor, request, { storage: this.storage, expectedRevision: request.expectedRevision });
    } catch (error) {
      if (error instanceof StorageConflictError) throw new ConflictException('This file changed after you opened it.');
      if (error instanceof TextSourceError || error instanceof TextEditValidationError || error instanceof BadRequestException) throw new BadRequestException(error instanceof TextEditValidationError ? error.message : 'The text changes are invalid.');
      throw error;
    }
  }

  write(content: PreviewContent, preview: DrivePreviewToken, response: Response, mimeType = preview.mimeType): void {
    const length = content.range
      ? content.range.end - content.range.start + 1
      : content.sizeBytes === null
        ? null
        : Number(content.sizeBytes);
    response.status(content.range ? 206 : 200);
    response.setHeader('Content-Type', mimeType);
    if (length !== null) response.setHeader('Content-Length', String(length));
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', contentDisposition(preview.filename, { type: 'inline' }));
    if (content.range) {
      response.setHeader(
        'Content-Range',
        `bytes ${content.range.start}-${content.range.end}/${content.range.total}`,
      );
    }
    const cleanup = () => {
      if (content.cleanup) void content.cleanup().catch(() => undefined);
    };
    response.once('finish', cleanup);
    response.once('close', cleanup);
    const close = () => content.stream.destroy();
    response.once('close', close);
    content.stream.once('error', () => {
      cleanup();
      if (!response.headersSent) response.status(503).end();
      else response.destroy();
    });
    content.stream.pipe(response);
  }

  private descriptor(preview: DrivePreviewToken): FileDescriptor {
    return {
      fileId: preview.did,
      nodeId: preview.nid,
      name: preview.filename,
      mimeType: preview.sourceMimeType ?? preview.mimeType,
      extension: preview.extension ?? extensionFromFilename(preview.filename),
      size: null,
      storageRef: previewRef(preview),
    };
  }

  private async convertOfficePreview(
    reference: StorageObjectRef,
    officeExtension?: string,
  ): Promise<PreviewContent> {
    const directory = await mkdtemp(join(tmpdir(), 'dochub-preview-'));
    const sourcePath = join(directory, `source${officeExtension ?? '.bin'}`);
    const pdfPath = join(directory, 'source.pdf');
    try {
      const source = previewContent(await this.storage.openRead(reference));
      await this.writeSource(source, sourcePath);
      await this.runLibreOffice(sourcePath, directory);
      const pdf = await stat(pdfPath);
      if (pdf.size > MAX_OFFICE_OUTPUT_BYTES) throw new Error('preview output too large');
      const stream = createReadStream(pdfPath);
      let cleaned = false;
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(directory, { recursive: true, force: true });
      };
      stream.once('error', () => void cleanup().catch(() => undefined));
      return {
        stream,
        mimeType: PREVIEW_PDF_MIME_TYPE,
        sizeBytes: BigInt(pdf.size),
        range: null,
        cleanup,
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.logger.warn(`Office preview conversion failed (${this.safeErrorKind(error)})`);
      throw safePreviewError();
    }
  }

  private async writeSource(source: PreviewContent, sourcePath: string): Promise<void> {
    if (source.sizeBytes !== null && source.sizeBytes > BigInt(MAX_OFFICE_INPUT_BYTES)) {
      source.stream.destroy();
      throw new Error('preview input too large');
    }
    const destination = await open(sourcePath, 'w', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of source.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_OFFICE_INPUT_BYTES) throw new Error('preview input too large');
        await destination.write(buffer);
      }
    } finally {
      await destination.close();
      source.stream.destroy();
    }
  }

  private runLibreOffice(sourcePath: string, directory: string): Promise<void> {
    const profilePath = join(directory, 'profile');
    const profileUrl = pathToFileURL(profilePath).href;
    const child = spawn(
      'libreoffice',
      [
        '--headless',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        '--nolockcheck',
        '--norestore',
        `-env:UserInstallation=${profileUrl}`,
        '--convert-to',
        'pdf',
        '--outdir',
        directory,
        sourcePath,
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          HOME: directory,
          TMPDIR: directory,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let outputBytes = 0;
    const capture = (chunk: Buffer | string) => {
      outputBytes = Math.min(MAX_CONVERTER_OUTPUT_BYTES, outputBytes + Buffer.byteLength(chunk));
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('preview conversion timed out'));
      }, LIBREOFFICE_TIMEOUT_MS);
      child.once('error', () => finish(new Error('preview converter failed')));
      child.once('close', (code) => {
        if (code !== 0) finish(new Error('preview converter failed'));
        else finish();
      });
    });
  }

  private safeErrorKind(error: unknown): string {
    if (error instanceof Error && error.message === 'preview input too large') return 'input-limit';
    if (error instanceof Error && error.message === 'preview output too large') return 'output-limit';
    if (error instanceof Error && error.message === 'preview conversion timed out') return 'timeout';
    if (error instanceof DocxPackageError || error instanceof SpreadsheetPackageError || error instanceof PresentationPackageError) return error.failureKind;
    if (error instanceof TextSourceError) return 'source';
    if (error instanceof Error && error.name) return error.name;
    return 'unknown-error';
  }
}
