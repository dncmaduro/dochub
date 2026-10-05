import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
  FileProcessingTaskType,
  FileVersionSource,
  NodeType,
  Prisma,
  UserStatus,
  AuditActorType,
  AuditResult,
  isSearchableFileMimeType,
} from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { CollectionsService } from '../collections/collections.service.js';
import { STORAGE_SERVICE } from '../storage/storage.module.js';
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
export class EditorSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EditorSessionService.name);
  private closeCleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
    private readonly jwt: JwtService,
    @Inject(EDITOR_CONFIG) private readonly config: EditorConfig | undefined,
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig,
    @Inject(STORAGE_SERVICE) private readonly objectStorage: StorageService,
    private readonly collections?: CollectionsService,
  ) {}

  onModuleInit() {
    if (!this.config) return;
    this.closeCleanupTimer = setInterval(() => {
      void this.closeExpiredEditSessions().catch((error: unknown) => {
        this.logger.error('Unable to close expired editor sessions', error);
      });
    }, 5_000);
    this.closeCleanupTimer.unref();
  }

  onModuleDestroy() {
    if (this.closeCleanupTimer) clearInterval(this.closeCleanupTimer);
  }

  /**
   * ONLYOFFICE uses this key as its document-server cache identity. Its source
   * URL is deliberately session-bound, so a FileVersion-only key would let a
   * later open reuse an entry whose source capability was revoked on close.
   */
  static documentKey(versionId: string, sessionId?: string): string {
    const scope = sessionId
      ? `editor-session:${sessionId}`
      : 'editor-document';
    return `oo-${createHash('sha256').update(`dochub-file-version:${versionId}:${scope}`).digest('base64url')}`;
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
    const sessionId = randomUUID();
    const session = await this.database.prisma.editorSession.create({
      data: {
        id: sessionId,
        fileId: node.file.id,
        baseVersionId: version.id,
        // VIEW sources are session-bound and revoked at close; EDIT remains
        // version-scoped so existing concurrent-editor behavior is unchanged.
        documentKey: EditorSessionService.documentKey(
          version.id,
          mode === 'VIEW' ? sessionId : undefined,
        ),
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
    void this.collections
      ?.recordRecent(actorUserId, nodeId)
      .catch(() => undefined);
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
    await this.closeExpiredEditSessions();
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        userId: actorUserId,
        actorType: EditorActorType.USER,
      },
      select: {
        id: true,
        status: true,
        mode: true,
        closedAt: true,
        finalizedFileVersionId: true,
      },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    if (session.status !== EditorSessionStatus.ACTIVE) return session;
    if (session.mode === EditorMode.VIEW)
      return this.database.prisma.editorSession.update({
        where: { id: session.id },
        data: { status: EditorSessionStatus.CLOSED, closedAt: new Date() },
        select: { id: true, status: true, mode: true, closedAt: true },
      });
    if (session.finalizedFileVersionId) return session;
    const closing = session.closedAt
      ? session
      : await this.database.prisma.editorSession.update({
          where: { id: session.id },
          // An ACTIVE EDIT session with closedAt set is server-side closing:
          // its UI is gone, but its signed final callback remains eligible for
          // the configured bounded grace period.
          data: { closedAt: new Date() },
          select: {
            id: true,
            status: true,
            mode: true,
            closedAt: true,
            finalizedFileVersionId: true,
          },
        });
    return this.waitForEditClose(closing.id, closing.closedAt!);
  }

  /** Closes EDIT sessions whose bounded final-callback window has elapsed. */
  async closeExpiredEditSessions(now = new Date()) {
    if (!this.config) return { count: 0 };
    const closeExpiry = new Date(
      now.getTime() - this.config.editCloseGraceSeconds * 1_000,
    );
    // A UI that disappears without calling close cannot retain a valid final
    // callback beyond the capability JWT's own lifetime. Closing such rows
    // bounds abandoned sessions without shortening an already-valid callback.
    const abandonedExpiry = new Date(
      now.getTime() - this.config.callbackTokenTtlSeconds * 1_000,
    );
    return this.database.prisma.editorSession.updateMany({
      where: {
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        finalizedFileVersionId: null,
        OR: [
          { closedAt: { not: null, lte: closeExpiry } },
          { closedAt: null, createdAt: { lte: abandonedExpiry } },
        ],
      },
      data: { status: EditorSessionStatus.CLOSED },
    });
  }

  private async waitForEditClose(sessionId: string, closedAt: Date) {
    const config = this.requireConfig();
    const deadline = new Date(
      closedAt.getTime() + config.editCloseGraceSeconds * 1_000,
    );
    for (;;) {
      const session = await this.database.prisma.editorSession.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          status: true,
          mode: true,
          closedAt: true,
          finalizedFileVersionId: true,
        },
      });
      if (!session || session.status !== EditorSessionStatus.ACTIVE)
        return session;
      if (new Date() >= deadline) {
        await this.closeExpiredEditSessions(new Date());
        continue;
      }
      // This is a bounded server-side completion contract, not browser-side
      // timing: the response completes only when finalization wins or the
      // configured callback eligibility window has definitively expired.
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  private isCallbackEligible(session: {
    mode: EditorMode;
    status: EditorSessionStatus;
    closedAt: Date | null;
  }) {
    if (session.status !== EditorSessionStatus.ACTIVE) return false;
    if (session.mode !== EditorMode.EDIT || !session.closedAt) return true;
    return (
      session.closedAt.getTime() +
        this.requireConfig().editCloseGraceSeconds * 1_000 >
      Date.now()
    );
  }

  async authorizeFetch(requestedSessionId: string, token: string) {
    const config = this.requireConfig();
    await this.closeExpiredEditSessions();
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
        status: true,
        closedAt: true,
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
      !this.isCallbackEligible(session) ||
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
    await this.closeExpiredEditSessions();
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
      // A retried save is acknowledged only after its durable result can be
      // identified. This also permits a CLOSED finalized session to absorb
      // ONLYOFFICE's callback retries.
      if (session.finalizedFileVersionId) return { error: 0 };
      if (payload.status === 1) {
        return { error: 0 };
      }
      if (payload.status === 4) {
        // A status 4 is a no-change close notification. Keep an EDIT session
        // open when it was not explicitly closed yet, so a transient
        // disconnect or a retried save remains eligible. Once the UI close
        // request has set closedAt, status 4 is the authoritative final
        // outcome and no version should be created.
        if (session.closedAt) {
          await this.database.prisma.editorSession.updateMany({
            where: {
              id: session.id,
              status: EditorSessionStatus.ACTIVE,
              finalizedFileVersionId: null,
            },
            data: {
              status: EditorSessionStatus.CLOSED,
              closedAt: session.closedAt,
            },
          });
        }
        return { error: 0 };
      }
      if (payload.status === 3 || payload.status === 7) return { error: 1 };
      if (payload.status !== 2 && payload.status !== 6) return { error: 0 };
      if (!session.stagedArtifactId) {
        if (!payload.url) throw new CallbackFailure();
        await this.stageEditedDocument(session, payload.url);
      }
      await this.finalizeStagedDocument(session.id);
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
        actorType: EditorActorType.USER,
      },
      select: {
        id: true,
        baseVersionId: true,
        documentKey: true,
        mode: true,
        stagedArtifactId: true,
        finalizedFileVersionId: true,
        status: true,
        closedAt: true,
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
    if (!session || (key !== undefined && key !== session.documentKey))
      throw new CallbackFailure();
    if (session.finalizedFileVersionId) return session;
    if (
      !this.isCallbackEligible(session) ||
      !session.userId ||
      !session.user ||
      session.user.status !== UserStatus.ACTIVE ||
      session.file.node.trashOperationId !== null ||
      session.file.currentVersionId !== session.baseVersionId
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
      const staged = await this.database.prisma.editorSession.updateMany({
        where: {
          id: session.id,
          stagedArtifactId: null,
          finalizedFileVersionId: null,
        },
        data: {
          stagedArtifactId: artifactId,
          stagedSha256: hash.digest('hex'),
          stagedSizeBytes: size,
          stagedAt: new Date(),
        },
      });
      // Another callback won the staging race. Its artifact is authoritative;
      // never replace it with a second download of the same logical save.
      if (staged.count !== 1) await rm(finalPath, { force: true });
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined);
      await rm(finalPath, { force: true }).catch(() => undefined);
      throw error instanceof CallbackFailure ? error : new CallbackFailure();
    }
  }

  private async finalizeStagedDocument(sessionId: string): Promise<void> {
    const staged = await this.database.prisma.editorSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        stagedArtifactId: true,
        stagedSha256: true,
        stagedSizeBytes: true,
        finalizedFileVersionId: true,
      },
    });
    if (!staged) throw new CallbackFailure();
    if (staged.finalizedFileVersionId) return;
    if (
      !staged.stagedArtifactId ||
      !staged.stagedSha256 ||
      staged.stagedSizeBytes === null
    )
      throw new CallbackFailure();

    const stagedPath = this.stagedPath(sessionId, staged.stagedArtifactId);
    await this.assertStagedArtifact(
      stagedPath,
      staged.stagedSizeBytes,
      staged.stagedSha256,
    );

    // Storage precedes the database transaction: a committed FileVersion can
    // therefore never point at an absent immutable object. On transaction
    // failure the object is removed, while staging remains for a safe retry.
    const versionId = randomUUID();
    let storageKey: string | undefined;
    try {
      const identity = await this.database.prisma.editorSession.findUnique({
        where: { id: sessionId },
        select: { fileId: true, finalizedFileVersionId: true },
      });
      if (!identity) throw new CallbackFailure();
      if (identity.finalizedFileVersionId) return;
      storageKey = `files/${identity.fileId}/versions/${versionId}`;
      await this.objectStorage.putStream(
        storageKey,
        createReadStream(stagedPath),
      );

      const finalized = await this.database.prisma.$transaction((transaction) =>
        this.commitEditorVersion(
          transaction,
          sessionId,
          versionId,
          storageKey!,
        ),
      );
      if (finalized.created) {
        await rm(stagedPath, { force: true }).catch(() => {
          this.logger.warn(
            `Unable to remove finalized editor staging artifact for session ${sessionId}`,
          );
        });
      } else {
        await this.objectStorage.delete(storageKey).catch(() => undefined);
      }
    } catch (error) {
      if (storageKey) {
        await this.objectStorage.delete(storageKey).catch(() => {
          this.logger.warn(
            'Editor finalization database failure left a storage orphan',
          );
        });
      }
      throw error instanceof CallbackFailure ? error : new CallbackFailure();
    }
  }

  private async commitEditorVersion(
    transaction: Prisma.TransactionClient,
    sessionId: string,
    versionId: string,
    storageKey: string,
  ): Promise<{ created: boolean }> {
    // Serialize same-session callback retries before examining the File row.
    const lockedSessions = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "EditorSession" WHERE "id" = ${sessionId}::uuid FOR UPDATE`;
    if (!lockedSessions[0]) throw new CallbackFailure();
    const session = await transaction.editorSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        fileId: true,
        baseVersionId: true,
        userId: true,
        mode: true,
        status: true,
        closedAt: true,
        stagedArtifactId: true,
        stagedSha256: true,
        stagedSizeBytes: true,
        finalizedFileVersionId: true,
        file: {
          select: {
            nodeId: true,
            node: { select: { trashOperationId: true } },
          },
        },
        baseVersion: {
          select: { originalFilename: true, mimeType: true, extension: true },
        },
        user: { select: { status: true } },
      },
    });
    if (!session) throw new CallbackFailure();
    if (session.finalizedFileVersionId) return { created: false };
    if (
      session.mode !== EditorMode.EDIT ||
      !this.isCallbackEligible(session) ||
      !session.userId ||
      session.user?.status !== UserStatus.ACTIVE ||
      !session.stagedArtifactId ||
      !session.stagedSha256 ||
      session.stagedSizeBytes === null ||
      session.file.node.trashOperationId !== null
    )
      throw new CallbackFailure();
    const caps = await this.authorization.resolveCapabilities(
      session.userId,
      session.file.nodeId,
      transaction,
    );
    if (
      !caps.capabilities.has(DocumentCapability.VIEW) ||
      !caps.capabilities.has(DocumentCapability.EDIT)
    )
      throw new CallbackFailure();
    const lockedFiles = await transaction.$queryRaw<
      Array<{
        id: string;
        versionCounter: number;
        currentVersionId: string | null;
      }>
    >`
      SELECT "id", "versionCounter", "currentVersionId" FROM "File"
      WHERE "id" = ${session.fileId}::uuid FOR UPDATE`;
    const file = lockedFiles[0];
    if (!file || file.currentVersionId !== session.baseVersionId)
      throw new CallbackFailure();
    const versionNumber = file.versionCounter + 1;
    await transaction.fileVersion.create({
      data: {
        id: versionId,
        fileId: file.id,
        versionNumber,
        storageKey,
        originalFilename: session.baseVersion.originalFilename,
        mimeType: session.baseVersion.mimeType,
        extension: session.baseVersion.extension,
        sizeBytes: session.stagedSizeBytes,
        sha256: session.stagedSha256,
        source: FileVersionSource.EDITOR,
        sourceVersionId: session.baseVersionId,
        createdById: session.userId,
      },
    });
    await transaction.file.update({
      where: { id: file.id },
      data: { versionCounter: versionNumber, currentVersionId: versionId },
    });
    if (isSearchableFileMimeType(session.baseVersion.mimeType)) {
      await transaction.fileProcessingTask.create({
        data: {
          fileVersionId: versionId,
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      });
    }
    await transaction.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId: session.userId,
        action: 'FILE_VERSION_CREATED',
        resourceType: 'FILE_VERSION',
        resourceId: versionId,
        result: AuditResult.SUCCESS,
        metadata: {
          fileId: file.id,
          nodeId: session.file.nodeId,
          versionNumber,
          source: 'EDITOR',
          sourceVersionId: session.baseVersionId,
          mimeType: session.baseVersion.mimeType,
          sizeBytes: session.stagedSizeBytes.toString(),
        },
      },
    });
    await transaction.editorSession.update({
      where: { id: session.id },
      data: {
        finalizedFileVersionId: versionId,
        finalizedAt: new Date(),
        status: EditorSessionStatus.CLOSED,
        closedAt: new Date(),
      },
    });
    return { created: true };
  }

  private stagedPath(sessionId: string, artifactId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        artifactId,
      )
    )
      throw new CallbackFailure();
    return path.join(
      this.storage.uploadTempRoot,
      'editor',
      sessionId,
      artifactId,
    );
  }

  private async assertStagedArtifact(
    pathname: string,
    expectedSize: bigint,
    expectedSha256: string,
  ): Promise<void> {
    const hash = createHash('sha256');
    let size = 0n;
    try {
      for await (const chunk of createReadStream(pathname)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += BigInt(bytes.length);
        if (size > BigInt(this.storage.uploadMaxBytes))
          throw new CallbackFailure();
        hash.update(bytes);
      }
    } catch (error) {
      throw error instanceof CallbackFailure ? error : new CallbackFailure();
    }
    if (size !== expectedSize || hash.digest('hex') !== expectedSha256)
      throw new CallbackFailure();
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
