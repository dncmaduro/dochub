import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NodeType } from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import contentDisposition from 'content-disposition';
import type { Response } from 'express';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
import { parseSingleByteRange, type ByteRange } from './byte-range.js';

export interface BinaryRead {
  stream: import('node:stream').Readable;
  version: { originalFilename: string; mimeType: string; sizeBytes: bigint };
  totalSize: bigint;
  range: ByteRange | null;
}

@Injectable()
export class FileReadService {
  private readonly logger = new Logger(FileReadService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  async open(
    actorUserId: string,
    nodeId: string,
    capability: DocumentCapability.PREVIEW | DocumentCapability.DOWNLOAD,
    rangeHeader: string | undefined,
    versionId?: string,
  ): Promise<BinaryRead> {
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        file: { select: { id: true, currentVersionId: true } },
      },
    });
    if (!node) throw new NotFoundException('Node not found');
    const capabilities = await this.authorization.resolveCapabilities(
      actorUserId,
      nodeId,
    );
    if (!capabilities.capabilities.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
    if (!capabilities.capabilities.has(capability)) {
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    }
    return this.openAuthorized(nodeId, rangeHeader, versionId);
  }

  /** Opens a current (or supplied historical) version after a caller has authorized the Node. */
  async openAuthorized(
    nodeId: string,
    rangeHeader: string | undefined,
    versionId?: string,
  ): Promise<BinaryRead> {
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        file: { select: { id: true, currentVersionId: true } },
      },
    });
    if (!node) throw new NotFoundException('Node not found');
    if (node.type !== NodeType.FILE)
      throw new ConflictException('Node is not a file');
    if (!node.file)
      throw new ServiceUnavailableException('File is unavailable');
    const resolvedVersionId = versionId ?? node.file.currentVersionId;
    if (!resolvedVersionId) {
      this.logger.warn('Active file has no current version');
      throw new ServiceUnavailableException('File is unavailable');
    }
    const version = await this.database.prisma.fileVersion.findFirst({
      where: { id: resolvedVersionId, fileId: node.file.id },
      select: {
        storageKey: true,
        originalFilename: true,
        mimeType: true,
        sizeBytes: true,
      },
    });
    if (!version) {
      if (!versionId)
        this.logger.warn('Active file current version is unavailable');
      else throw new NotFoundException('Version not found');
      throw new ServiceUnavailableException('File is unavailable');
    }
    let physical;
    try {
      physical = await this.storage.stat(version.storageKey);
    } catch {
      this.logger.error('File version storage object is unavailable');
      throw new ServiceUnavailableException('File is unavailable');
    }
    if (physical.sizeBytes !== version.sizeBytes) {
      this.logger.error('File version storage size does not match metadata');
      throw new ServiceUnavailableException('File is unavailable');
    }
    const range = parseSingleByteRange(rangeHeader, physical.sizeBytes);
    try {
      return {
        stream: await this.storage.openReadStream(
          version.storageKey,
          range ?? undefined,
        ),
        version,
        totalSize: physical.sizeBytes,
        range,
      };
    } catch {
      this.logger.error('File version storage stream could not be opened');
      throw new ServiceUnavailableException('File is unavailable');
    }
  }

  write(binary: BinaryRead, response: Response, attachment = false): void {
    const length = binary.range
      ? binary.range.end - binary.range.start + 1
      : Number(binary.totalSize);
    response.status(binary.range ? 206 : 200);
    response.setHeader('Content-Type', binary.version.mimeType);
    response.setHeader('Content-Length', String(length));
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      contentDisposition(binary.version.originalFilename, {
        type: attachment ? 'attachment' : 'inline',
      }),
    );
    if (binary.range)
      response.setHeader(
        'Content-Range',
        `bytes ${binary.range.start}-${binary.range.end}/${binary.totalSize}`,
      );
    const close = () => binary.stream.destroy();
    response.once('close', close);
    binary.stream.once('error', () => {
      if (!response.headersSent) response.status(503).end();
      else response.destroy();
    });
    binary.stream.pipe(response);
  }
}
