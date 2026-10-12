import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
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
import type { DriveContent } from './google-drive.provider.js';
import { DriveService } from './drive.service.js';
import { STORAGE_PROVIDER } from '../storage/storage-provider.js';
import type {
  StorageObjectRef,
  StorageProvider,
  StorageReadResult,
} from '../storage/storage-provider.js';
import { parseSingleByteRange } from '../files/byte-range.js';

const DRIVE_PREVIEW_AUDIENCE = 'dochub-drive-preview';
const DRIVE_PREVIEW_TTL_SECONDS = 300;
const PREVIEW_PDF_MIME_TYPE = 'application/pdf';
const LIBREOFFICE_TIMEOUT_MS = 30_000;
const MAX_OFFICE_INPUT_BYTES = 50 * 1024 * 1024;
const MAX_OFFICE_OUTPUT_BYTES = 100 * 1024 * 1024;
const MAX_CONVERTER_OUTPUT_BYTES = 8 * 1024;

const DIRECT_PREVIEW_MIME_TYPES = new Set([
  PREVIEW_PDF_MIME_TYPE,
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
]);

const GOOGLE_NATIVE_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

const OFFICE_MIME_EXTENSIONS = new Map([
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
]);

const OFFICE_EXTENSION_MIME_TYPES = new Map([
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

type DrivePreviewPlan =
  | { kind: 'direct'; mimeType: string }
  | { kind: 'google-export'; mimeType: typeof PREVIEW_PDF_MIME_TYPE }
  | { kind: 'office'; mimeType: typeof PREVIEW_PDF_MIME_TYPE; extension: string };

type DrivePreviewToken = {
  typ: 'drive-preview';
  sid: string;
  sub: string;
  nid: string;
  did: string;
  mimeType: string;
  filename: string;
  kind?: DrivePreviewPlan['kind'];
  officeExtension?: string;
};

type PreviewContent = {
  stream: DriveContent['stream'];
  mimeType: string;
  sizeBytes: bigint | null;
  range: DriveContent['range'];
  cleanup?: () => Promise<void>;
};

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
};

function previewPlan(mimeType: string, filename: string): DrivePreviewPlan | null {
  const normalized = mimeType.toLowerCase();
  if (DIRECT_PREVIEW_MIME_TYPES.has(normalized)) {
    return { kind: 'direct', mimeType: normalized };
  }
  // Google metadata wins over the extension fallback. A Google Doc named
  // "report.docx" must still use Drive export, never LibreOffice.
  if (GOOGLE_NATIVE_MIME_TYPES.has(normalized)) {
    return { kind: 'google-export', mimeType: PREVIEW_PDF_MIME_TYPE };
  }
  const extension = OFFICE_MIME_EXTENSIONS.get(normalized) ?? controlledOfficeExtension(filename);
  if (extension && (OFFICE_MIME_EXTENSIONS.has(normalized) || !normalized.startsWith('application/vnd.google-apps.'))) {
    return { kind: 'office', mimeType: PREVIEW_PDF_MIME_TYPE, extension };
  }
  return null;
}

function controlledOfficeExtension(filename: string): string | undefined {
  const match = /\.[a-z0-9]+$/i.exec(filename);
  if (!match) return undefined;
  const extension = match[0].toLowerCase();
  return OFFICE_EXTENSION_MIME_TYPES.has(extension) ? extension : undefined;
}

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
    const plan = previewPlan(source.mimeType, node.name);
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
        filename: node.name,
        ...(plan ? { kind: plan.kind } : {}),
        ...(plan?.kind === 'office' ? { officeExtension: plan.extension } : {}),
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

  async openContent(preview: DrivePreviewToken, rangeHeader?: string): Promise<PreviewContent> {
    if (preview.kind === 'google-export') {
      return this.drive.openPreviewExport(preview.did, PREVIEW_PDF_MIME_TYPE);
    }
    if (preview.kind === 'office') {
      return this.convertOfficePreview(
        previewRef(preview),
        preview.officeExtension,
      );
    }
    const reference = previewRef(preview);
    let range = null;
    if (rangeHeader) {
      const current = await this.storage.stat(reference);
      if (current.sizeBytes === null) throw safePreviewError();
      range = parseSingleByteRange(rangeHeader, current.sizeBytes);
    }
    return previewContent(
      await this.storage.openRead(reference, range ? { range } : undefined),
    );
  }

  write(content: PreviewContent, preview: DrivePreviewToken, response: Response): void {
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
    return 'conversion-error';
  }
}
