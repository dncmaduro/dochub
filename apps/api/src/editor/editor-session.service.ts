import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  EditorActorType,
  EditorMode,
  EditorSessionStatus,
  NodeType,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import {
  STORAGE_CONFIG,
  type StorageConfig,
} from '../storage/storage.config.js';
import { EDITOR_CONFIG, type EditorConfig } from './editor.config.js';
import { fileExtension, officeDocumentType } from './editor.types.js';

interface FetchCapability {
  aud: 'onlyoffice-file-fetch';
  sessionId: string;
  fileVersionId: string;
  purpose: 'onlyoffice-file-fetch';
}
interface CallbackCapability {
  aud: 'onlyoffice-callback';
  sessionId: string;
  baseVersionId: string;
  purpose: 'onlyoffice-callback';
}
interface OnlyOfficeCallback {
  status: number;
  url?: string;
  key?: string;
  token?: string;
}
class CallbackFailure extends Error {}

@Injectable()
export class EditorSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly jwt: JwtService,
    @Inject(EDITOR_CONFIG) private readonly config: EditorConfig | undefined,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
  ) {}

  static documentKey(versionId: string): string {
    return `oo-${createHash('sha256').update(`dochub-file-version:${versionId}`).digest('base64url')}`;
  }

  async create(
    actorUserId: string,
    nodeId: string,
    mode: 'VIEW' | 'EDIT' = 'VIEW',
  ) {
    const config = this.requireConfig();
    const node = await this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        file: {
          select: {
            id: true,
            currentVersionId: true,
            currentVersion: {
              select: { id: true, originalFilename: true, extension: true },
            },
          },
        },
      },
    });
    if (!node) throw new NotFoundException('Node not found');
    const capabilities = await this.authorization.resolveCapabilities(
      actorUserId,
      node.id,
    );
    if (!capabilities.capabilities.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
    if (
      mode === 'EDIT'
        ? !capabilities.capabilities.has(DocumentCapability.EDIT)
        : !capabilities.capabilities.has(DocumentCapability.PREVIEW)
    )
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    if (node.type !== NodeType.FILE)
      throw new ConflictException('Node is not a file');
    if (!node.file?.currentVersionId || !node.file.currentVersion)
      throw new ServiceUnavailableException('File is unavailable');
    const version = node.file.currentVersion;
    const extension = fileExtension(
      version.originalFilename,
      version.extension,
    );
    const documentType = officeDocumentType(extension);
    if (!documentType)
      throw new UnsupportedMediaTypeException(
        'ONLYOFFICE supports Office documents only',
      );
    const actor = await this.database.prisma.user.findFirst({
      where: { id: actorUserId, status: UserStatus.ACTIVE },
      select: { id: true, displayName: true },
    });
    if (!actor) throw new NotFoundException('Node not found');
    const session = await this.database.prisma.editorSession.create({
      data: {
        fileId: node.file.id,
        baseVersionId: version.id,
        documentKey: EditorSessionService.documentKey(version.id),
        actorType: EditorActorType.USER,
        userId: actor.id,
        mode: mode === 'EDIT' ? EditorMode.EDIT : EditorMode.VIEW,
        status: EditorSessionStatus.ACTIVE,
      },
      select: {
        id: true,
        mode: true,
        status: true,
        baseVersionId: true,
        documentKey: true,
      },
    });
    const fetchToken = await this.signFetchToken(
      session.id,
      version.id,
      config,
    );
    const documentUrl = new URL(
      `editor-sessions/${session.id}/content`,
      config.internalApiUrl,
    );
    documentUrl.searchParams.set('token', fetchToken);
    const editable = mode === 'EDIT';
    const unsignedConfig: Record<string, unknown> = {
      documentType,
      document: {
        fileType: extension,
        key: session.documentKey,
        title: version.originalFilename,
        url: documentUrl.toString(),
        permissions: {
          edit: editable,
          comment: false,
          review: false,
          fillForms: false,
          modifyFilter: false,
          download: capabilities.capabilities.has(DocumentCapability.DOWNLOAD),
          print: capabilities.capabilities.has(DocumentCapability.DOWNLOAD),
        },
      },
      editorConfig: {
        mode: editable ? 'edit' : 'view',
        user: { id: actor.id, name: actor.displayName },
      },
    };
    if (editable) {
      const callbackUrl = new URL(
        `editor-sessions/${session.id}/callback`,
        config.internalApiUrl,
      );
      callbackUrl.searchParams.set(
        'capability',
        await this.signCallbackToken(session.id, version.id, config),
      );
      (unsignedConfig.editorConfig as Record<string, unknown>).callbackUrl =
        callbackUrl.toString();
    }
    const token = await this.jwt.signAsync(unsignedConfig, {
      secret: config.jwtSecret,
      algorithm: 'HS256',
    });
    return {
      session: {
        id: session.id,
        mode: session.mode,
        status: session.status,
        expiresAt: null,
      },
      documentServer: {
        apiUrl: new URL(
          'web-apps/apps/api/documents/api.js',
          config.publicUrl,
        ).toString(),
      },
      config: { ...unsignedConfig, token },
    };
  }

  async close(actorUserId: string, sessionId: string) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        userId: actorUserId,
        actorType: EditorActorType.USER,
      },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    if (session.status === EditorSessionStatus.ACTIVE)
      return this.database.prisma.editorSession.update({
        where: { id: session.id },
        data: { status: EditorSessionStatus.CLOSED, closedAt: new Date() },
        select: { id: true, status: true, mode: true, closedAt: true },
      });
    return session;
  }

  async authorizeFetch(requestedSessionId: string, token: string) {
    const config = this.requireConfig();
    let cap: FetchCapability;
    try {
      cap = await this.jwt.verifyAsync<FetchCapability>(token, {
        secret: config.fetchTokenSecret,
        algorithms: ['HS256'],
        audience: 'onlyoffice-file-fetch',
      });
    } catch {
      throw new NotFoundException('Editor resource not found');
    }
    if (
      cap.sessionId !== requestedSessionId ||
      cap.purpose !== 'onlyoffice-file-fetch' ||
      typeof cap.fileVersionId !== 'string'
    )
      throw new NotFoundException('Editor resource not found');
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: cap.sessionId,
        baseVersionId: cap.fileVersionId,
        actorType: EditorActorType.USER,
        status: EditorSessionStatus.ACTIVE,
      },
      select: {
        id: true,
        fileId: true,
        baseVersionId: true,
        userId: true,
        mode: true,
        file: {
          select: {
            nodeId: true,
            node: { select: { trashOperationId: true } },
          },
        },
        baseVersion: { select: { id: true, fileId: true } },
        user: { select: { status: true } },
      },
    });
    if (
      !session ||
      !session.userId ||
      !session.user ||
      session.user.status !== UserStatus.ACTIVE ||
      session.baseVersion.fileId !== session.fileId ||
      session.file.node.trashOperationId !== null
    )
      throw new NotFoundException('Editor resource not found');
    const caps = await this.authorization.resolveCapabilities(
      session.userId,
      session.file.nodeId,
    );
    if (
      !caps.capabilities.has(DocumentCapability.VIEW) ||
      !(session.mode === EditorMode.EDIT
        ? caps.capabilities.has(DocumentCapability.EDIT)
        : caps.capabilities.has(DocumentCapability.PREVIEW))
    )
      throw new NotFoundException('Editor resource not found');
    return { nodeId: session.file.nodeId, versionId: session.baseVersionId };
  }

  async handleCallback(
    sessionId: string,
    capabilityToken: string,
    input: unknown,
  ): Promise<{ error: number }> {
    const config = this.requireConfig();
    const payload = this.callbackPayload(input);
    let signed: OnlyOfficeCallback;
    try {
      signed = await this.jwt.verifyAsync<OnlyOfficeCallback>(payload.token!, {
        secret: config.jwtSecret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid editor callback');
    }
    if (
      signed.status !== payload.status ||
      signed.url !== payload.url ||
      signed.key !== payload.key
    ) {
      throw new UnauthorizedException('Invalid editor callback');
    }
    let cap: CallbackCapability;
    try {
      cap = await this.jwt.verifyAsync<CallbackCapability>(capabilityToken, {
        secret: config.fetchTokenSecret,
        algorithms: ['HS256'],
        audience: 'onlyoffice-callback',
      });
    } catch {
      throw new UnauthorizedException('Invalid editor callback');
    }
    if (
      cap.sessionId !== sessionId ||
      cap.purpose !== 'onlyoffice-callback' ||
      typeof cap.baseVersionId !== 'string'
    ) {
      throw new UnauthorizedException('Invalid editor callback');
    }
    try {
      const session = await this.callbackSession(
        sessionId,
        cap.baseVersionId,
        signed.key,
      );
      if (payload.status === 1 || payload.status === 4) {
        // A status 4 is a no-change close notification. Do not close an EDIT
        // session here: it can follow a rejected/retried save callback and
        // closing would make a later legitimate status 2/6 unrecoverable.
        return { error: 0 };
      }
      if (payload.status === 3 || payload.status === 7) return { error: 1 };
      if (payload.status !== 2 && payload.status !== 6) return { error: 0 };
      if (session.stagedArtifactId) return { error: 0 };
      if (!payload.url) throw new CallbackFailure();
      await this.stageEditedDocument(session, payload.url);
      return { error: 0 };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      return { error: 1 };
    }
  }

  private callbackPayload(input: unknown): OnlyOfficeCallback {
    if (!input || typeof input !== 'object')
      throw new UnauthorizedException('Invalid editor callback');
    const value = input as Record<string, unknown>;
    if (
      !Number.isInteger(value.status) ||
      typeof value.token !== 'string' ||
      (value.url !== undefined && typeof value.url !== 'string') ||
      (value.key !== undefined && typeof value.key !== 'string')
    )
      throw new UnauthorizedException('Invalid editor callback');
    return {
      status: value.status as number,
      url: value.url as string | undefined,
      key: value.key as string | undefined,
      token: value.token as string,
    };
  }

  private async callbackSession(
    sessionId: string,
    baseVersionId: string,
    key?: string,
  ) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        baseVersionId,
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        actorType: EditorActorType.USER,
      },
      select: {
        id: true,
        baseVersionId: true,
        documentKey: true,
        stagedArtifactId: true,
        userId: true,
        file: {
          select: {
            currentVersionId: true,
            nodeId: true,
            node: { select: { trashOperationId: true } },
          },
        },
        user: { select: { status: true } },
      },
    });
    if (
      !session ||
      !session.userId ||
      !session.user ||
      session.user.status !== UserStatus.ACTIVE ||
      session.file.node.trashOperationId !== null ||
      session.file.currentVersionId !== session.baseVersionId ||
      (key !== undefined && key !== session.documentKey)
    )
      throw new CallbackFailure();
    const caps = await this.authorization.resolveCapabilities(
      session.userId,
      session.file.nodeId,
    );
    if (
      !caps.capabilities.has(DocumentCapability.VIEW) ||
      !caps.capabilities.has(DocumentCapability.EDIT)
    )
      throw new CallbackFailure();
    return session;
  }

  private async stageEditedDocument(
    session: { id: string },
    url: string,
  ): Promise<void> {
    const config = this.requireConfig();
    let source: URL;
    try {
      source = new URL(url);
    } catch {
      throw new CallbackFailure();
    }
    if (
      source.protocol !== config.publicUrl.protocol ||
      source.hostname !== config.publicUrl.hostname ||
      source.port !== config.publicUrl.port
    )
      throw new CallbackFailure();
    const artifactId = randomUUID();
    const directory = path.join(
      this.storage.uploadTempRoot,
      'editor',
      session.id,
    );
    const finalPath = path.join(directory, artifactId);
    const partialPath = `${finalPath}.partial`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let response: Response;
      try {
        response = await fetch(source, {
          redirect: 'error',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok || !response.body) throw new CallbackFailure();
      const hash = createHash('sha256');
      let size = 0n;
      const counter = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          size += BigInt(chunk.length);
          if (size > BigInt(this.storage.uploadMaxBytes))
            return done(new CallbackFailure());
          hash.update(chunk);
          done(null, chunk);
        },
      });
      await pipeline(
        response.body as unknown as NodeJS.ReadableStream,
        counter,
        createWriteStream(partialPath, {
          flags: 'wx',
          mode: 0o600,
          flush: true,
        }),
      );
      await rename(partialPath, finalPath);
      await this.database.prisma.editorSession.update({
        where: { id: session.id },
        data: {
          stagedArtifactId: artifactId,
          stagedSha256: hash.digest('hex'),
          stagedSizeBytes: size,
          stagedAt: new Date(),
        },
      });
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error instanceof CallbackFailure ? error : new CallbackFailure();
    }
  }

  private signFetchToken(
    sessionId: string,
    fileVersionId: string,
    config: EditorConfig,
  ) {
    return this.jwt.signAsync<FetchCapability>(
      {
        aud: 'onlyoffice-file-fetch',
        sessionId,
        fileVersionId,
        purpose: 'onlyoffice-file-fetch',
      },
      {
        secret: config.fetchTokenSecret,
        algorithm: 'HS256',
        expiresIn: config.fetchTokenTtlSeconds,
      },
    );
  }
  private signCallbackToken(
    sessionId: string,
    baseVersionId: string,
    config: EditorConfig,
  ) {
    return this.jwt.signAsync<CallbackCapability>(
      {
        aud: 'onlyoffice-callback',
        sessionId,
        baseVersionId,
        purpose: 'onlyoffice-callback',
      },
      {
        secret: config.fetchTokenSecret,
        algorithm: 'HS256',
        expiresIn: config.callbackTokenTtlSeconds,
      },
    );
  }
  private requireConfig(): EditorConfig {
    if (!this.config)
      throw new ServiceUnavailableException('ONLYOFFICE is not configured');
    return this.config;
  }
}
