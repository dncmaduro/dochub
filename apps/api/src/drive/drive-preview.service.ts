import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FileBackingType, UserStatus } from '@dochub/database';
import contentDisposition from 'content-disposition';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import type { DriveContent } from './google-drive.provider.js';
import { DriveService } from './drive.service.js';

const DRIVE_PREVIEW_AUDIENCE = 'dochub-drive-preview';
const DRIVE_PREVIEW_TTL_SECONDS = 300;
const GOOGLE_NATIVE_EXPORTS = new Map([
  ['application/vnd.google-apps.document', 'application/pdf'],
  ['application/vnd.google-apps.spreadsheet', 'application/pdf'],
  ['application/vnd.google-apps.presentation', 'application/pdf'],
]);

type DrivePreviewToken = {
  typ: 'drive-preview';
  sid: string;
  sub: string;
  nid: string;
  did: string;
  mimeType: string;
  exportMimeType: string | null;
  filename: string;
};

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
};

function previewPlan(mimeType: string): { mimeType: string; exportMimeType: string | null } | null {
  const normalized = mimeType.toLowerCase();
  const nativeExport = GOOGLE_NATIVE_EXPORTS.get(normalized);
  if (nativeExport) return { mimeType: nativeExport, exportMimeType: nativeExport };
  if (
    normalized === 'application/pdf' ||
    normalized.startsWith('image/') ||
    normalized === 'video/mp4' ||
    normalized === 'video/webm' ||
    normalized.startsWith('text/') ||
    normalized === 'application/json' ||
    normalized === 'application/xml'
  ) {
    return { mimeType: normalized, exportMimeType: null };
  }
  return null;
}

@Injectable()
export class DrivePreviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly jwt: JwtService,
    private readonly drive: DriveService,
  ) {}

  cookieName(sessionId: string): string {
    return `dochub_drive_preview_${sessionId}`;
  }

  async create(userId: string, nodeId: string): Promise<DrivePreviewSession | null> {
    const capabilities = await this.authorization.resolveCapabilities(userId, nodeId);
    if (!capabilities.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    if (!capabilities.capabilities.has(DocumentCapability.PREVIEW)) {
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
    const plan = previewPlan(source.mimeType);
    if (!plan && !capabilities.capabilities.has(DocumentCapability.DOWNLOAD)) return null;
    await this.drive.assertReadableDrive();
    const outputMimeType = plan?.mimeType ?? source.mimeType.toLowerCase();
    const sessionId = randomUUID();
    const token = await this.jwt.signAsync<DrivePreviewToken>(
      {
        typ: 'drive-preview',
        sid: sessionId,
        sub: userId,
        nid: node.id,
        did: source.driveFileId,
        mimeType: outputMimeType,
        exportMimeType: plan?.exportMimeType ?? null,
        filename: node.name,
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

  openContent(preview: DrivePreviewToken, rangeHeader?: string): Promise<DriveContent> {
    return this.drive.openPreviewContent(preview.did, preview.exportMimeType, rangeHeader);
  }

  write(content: DriveContent, preview: DrivePreviewToken, response: Response): void {
    const length = content.range
      ? content.range.end - content.range.start + 1
      : content.sizeBytes === null
        ? null
        : Number(content.sizeBytes);
    response.status(content.range ? 206 : 200);
    response.setHeader('Content-Type', preview.mimeType);
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
    const close = () => content.stream.destroy();
    response.once('close', close);
    content.stream.once('error', () => {
      if (!response.headersSent) response.status(503).end();
      else response.destroy();
    });
    content.stream.pipe(response);
  }
}
