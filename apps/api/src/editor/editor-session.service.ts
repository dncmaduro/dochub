import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
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
  GeneralAccessRole,
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
import {
  DocumentCapability,
  generalAccessCapabilities,
} from '../authorization/document-capability.js';
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
  private readonly finalizationsInFlight = new Map<string, Promise<void>>();

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
    const scope = sessionId ? `editor-session:${sessionId}` : 'editor-document';
    return `oo-${createHash('sha256').update(`dochub-file-version:${versionId}:${scope}`).digest('base64url')}`;
  }

  async create(
    actorUserId: string,
    nodeId: string,
    requestedMode?: 'VIEW' | 'EDIT',
  ) {
    await this.closeExpiredEditSessions();
    const node = await this.workspaceNode(nodeId);
    if (!node) throw new NotFoundException('Node not found');
    const capabilities = await this.authorization.resolveCapabilities(
      actorUserId,
      node.id,
    );
    const effective = new Set(capabilities.capabilities);
    for (const capability of generalAccessCapabilities(node.generalAccessRole))
      effective.add(capability);
    if (!effective.has(DocumentCapability.VIEW))
      throw new NotFoundException('Node not found');
    const canEdit = effective.has(DocumentCapability.EDIT);
    const mode = requestedMode ?? (canEdit ? 'EDIT' : 'VIEW');
    if (
      (mode === 'EDIT' && !canEdit) ||
      !effective.has(DocumentCapability.PREVIEW)
    )
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    const actor = await this.database.prisma.user.findFirst({
      where: { id: actorUserId, status: UserStatus.ACTIVE },
      select: { id: true, displayName: true },
    });
    if (!actor) throw new NotFoundException('Node not found');
    return this.createResolvedSession(node, effective, {
      actorType: EditorActorType.USER,
      userId: actor.id,
      userName: actor.displayName,
      mode,
    });
  }

  async createPublic(nodeId: string, requestedMode?: 'VIEW' | 'EDIT') {
    await this.closeExpiredEditSessions();
    const node = await this.workspaceNode(nodeId);
    if (!node || node.type !== NodeType.FILE)
      throw new NotFoundException('Document not found');
    const capabilities = generalAccessCapabilities(node.generalAccessRole);
    if (!capabilities.has(DocumentCapability.VIEW))
      throw new ForbiddenException('You do not have access to this document');
    const canEdit = capabilities.has(DocumentCapability.EDIT);
    const mode = requestedMode ?? (canEdit ? 'EDIT' : 'VIEW');
    if (
      (mode === 'EDIT' && !canEdit) ||
      !capabilities.has(DocumentCapability.PREVIEW)
    )
      throw new ForbiddenException(
        'You do not have the required document capability',
      );
    return this.createResolvedSession(node, capabilities, {
      actorType: EditorActorType.PUBLIC,
      userId: null,
      userName: 'Link guest',
      mode,
    });
  }

  private async workspaceNode(nodeId: string) {
    return this.database.prisma.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: {
        id: true,
        type: true,
        generalAccessRole: true,
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
  }

  private async createResolvedSession(
    node: NonNullable<
      Awaited<ReturnType<EditorSessionService['workspaceNode']>>
    >,
    capabilities: ReadonlySet<DocumentCapability>,
    actor: {
      actorType: EditorActorType;
      userId: string | null;
      userName: string;
      mode: 'VIEW' | 'EDIT';
    },
  ) {
    const config = this.requireConfig();
    if (node.type !== NodeType.FILE)
      throw new ConflictException('Node is not a file');
    if (!node.file?.currentVersionId || !node.file.currentVersion)
      throw new ServiceUnavailableException('File is unavailable');
    const closingSession = await this.database.prisma.editorSession.findFirst({
      where: {
        fileId: node.file.id,
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        closedAt: { not: null },
        finalizedFileVersionId: null,
      },
      select: { id: true },
    });
    if (closingSession)
      throw new ConflictException('File is still being saved');
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
    if (actor.mode === 'EDIT' && !capabilities.has(DocumentCapability.EDIT))
      throw new ForbiddenException('You do not have permission to edit');
    const sessionId = randomUUID();
    const session = await this.database.prisma.editorSession.create({
      data: {
        id: sessionId,
        fileId: node.file.id,
        baseVersionId: version.id,
        documentKey: EditorSessionService.documentKey(
          version.id,
          actor.mode === 'VIEW' || actor.actorType === EditorActorType.PUBLIC
            ? sessionId
            : undefined,
        ),
        actorType: actor.actorType,
        userId: actor.userId,
        mode: actor.mode === 'EDIT' ? EditorMode.EDIT : EditorMode.VIEW,
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
    const editable = actor.mode === 'EDIT';
    const allowDownload =
      actor.actorType === EditorActorType.USER &&
      capabilities.has(DocumentCapability.DOWNLOAD);
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
          download: allowDownload,
          print: allowDownload,
        },
      },
      editorConfig: {
        mode: editable ? 'edit' : 'view',
        user: {
          id: actor.userId ?? `guest-${randomUUID()}`,
          name: actor.userName,
        },
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
    await this.database.prisma.auditLog.create({
      data: {
        actorType:
          actor.actorType === EditorActorType.PUBLIC
            ? AuditActorType.PUBLIC
            : AuditActorType.USER,
        actorId: actor.userId,
        action:
          actor.actorType === EditorActorType.PUBLIC
            ? 'PUBLIC_EDITOR_SESSION_CREATED'
            : 'EDITOR_SESSION_CREATED',
        resourceType: 'NODE',
        resourceId: node.id,
        result: AuditResult.SUCCESS,
        metadata: {
          editorSessionId: session.id,
          mode: actor.mode,
        },
      },
    });
    if (actor.userId)
      void this.collections
        ?.recordRecent(actor.userId, node.id)
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
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        userId: actorUserId,
        actorType: EditorActorType.USER,
      },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    return this.acceptClose(session);
  }

  async closePublic(nodeId: string, sessionId: string) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        actorType: EditorActorType.PUBLIC,
        file: { nodeId },
      },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    return this.acceptClose(session);
  }

  async status(actorUserId: string, sessionId: string) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        userId: actorUserId,
        actorType: EditorActorType.USER,
      },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    return this.safeSessionState(session);
  }

  async statusPublic(nodeId: string, sessionId: string) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        actorType: EditorActorType.PUBLIC,
        file: { nodeId },
      },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!session) throw new NotFoundException('Editor session not found');
    return this.safeSessionState(session);
  }

  private async acceptClose(session: {
    id: string;
    status: EditorSessionStatus;
    mode: EditorMode;
    closedAt: Date | null;
  }) {
    if (session.status === EditorSessionStatus.ACTIVE) {
      if (session.mode === EditorMode.VIEW) {
        await this.database.prisma.editorSession.updateMany({
          where: { id: session.id, status: EditorSessionStatus.ACTIVE },
          data: { status: EditorSessionStatus.CLOSED, closedAt: new Date() },
        });
      } else if (!session.closedAt) {
        // Persist close acceptance before responding. The ONLYOFFICE callback
        // then owns finalization even if this browser tab disappears.
        await this.database.prisma.editorSession.updateMany({
          where: {
            id: session.id,
            status: EditorSessionStatus.ACTIVE,
            closedAt: null,
            finalizedFileVersionId: null,
          },
          data: { closedAt: new Date() },
        });
      }
    }
    const current = await this.database.prisma.editorSession.findUnique({
      where: { id: session.id },
      select: { id: true, status: true, mode: true, closedAt: true },
    });
    if (!current) throw new NotFoundException('Editor session not found');
    return this.safeSessionState(current);
  }

  private safeSessionState(session: {
    id: string;
    status: EditorSessionStatus;
    mode: EditorMode;
    closedAt: Date | null;
  }) {
    const state =
      session.status === EditorSessionStatus.FAILED
        ? 'FAILED'
        : session.status === EditorSessionStatus.CLOSED
          ? 'CLOSED'
          : session.closedAt && session.mode === EditorMode.EDIT
            ? 'FINALIZING'
            : 'ACTIVE';
    return { id: session.id, state, status: session.status };
  }

  /** Marks expired explicit closes failed and closes abandoned EDIT sessions. */
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
    const failedClose = await this.database.prisma.editorSession.updateMany({
      where: {
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        finalizedFileVersionId: null,
        closedAt: { not: null, lte: closeExpiry },
      },
      data: { status: EditorSessionStatus.FAILED },
    });
    const abandoned = await this.database.prisma.editorSession.updateMany({
      where: {
        mode: EditorMode.EDIT,
        status: EditorSessionStatus.ACTIVE,
        finalizedFileVersionId: null,
        closedAt: null,
        createdAt: { lte: abandonedExpiry },
      },
      data: { status: EditorSessionStatus.CLOSED },
    });
    const expiredArtifacts = await this.database.prisma.editorSession.findMany({
      where: {
        mode: EditorMode.EDIT,
        status: {
          in: [EditorSessionStatus.FAILED, EditorSessionStatus.CLOSED],
        },
        finalizedFileVersionId: null,
        stagedArtifactId: { not: null },
        OR: [
          { closedAt: { not: null, lte: closeExpiry } },
          { closedAt: null, createdAt: { lte: abandonedExpiry } },
        ],
      },
      select: { id: true, stagedArtifactId: true },
    });
    await Promise.all(
      expiredArtifacts.map(async (artifact) => {
        if (!artifact.stagedArtifactId) return;
        try {
          await this.objectStorage.delete(
            this.stagedKey(artifact.id, artifact.stagedArtifactId),
          );
        } catch {
          this.logger.warn(
            `Unable to remove failed editor staging artifact for session ${artifact.id}`,
          );
        }
      }),
    );
    return { count: failedClose.count + abandoned.count };
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

  private async sessionCapabilities(
    actorType: EditorActorType,
    userId: string | null,
    nodeId: string,
    generalAccessRole: GeneralAccessRole,
    transaction?: Prisma.TransactionClient,
  ): Promise<ReadonlySet<DocumentCapability> | null> {
    if (actorType === EditorActorType.PUBLIC) {
      if (userId || generalAccessRole === GeneralAccessRole.RESTRICTED)
        return null;
      return generalAccessCapabilities(generalAccessRole);
    }
    if (!userId) return null;
    const resolved = transaction
      ? await this.authorization.resolveCapabilities(
          userId,
          nodeId,
          transaction,
        )
      : await this.authorization.resolveCapabilities(userId, nodeId);
    const capabilities = new Set(resolved.capabilities);
    for (const capability of generalAccessCapabilities(generalAccessRole))
      capabilities.add(capability);
    return capabilities;
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
        status: EditorSessionStatus.ACTIVE,
      },
      select: {
        id: true,
        fileId: true,
        baseVersionId: true,
        actorType: true,
        userId: true,
        mode: true,
        status: true,
        closedAt: true,
        file: {
          select: {
            nodeId: true,
            node: {
              select: { trashOperationId: true, generalAccessRole: true },
            },
          },
        },
        baseVersion: { select: { id: true, fileId: true } },
        user: { select: { status: true } },
      },
    });
    if (
      !session ||
      !this.isCallbackEligible(session) ||
      session.baseVersion.fileId !== session.fileId ||
      session.file.node.trashOperationId !== null
    )
      throw new NotFoundException('Editor resource not found');
    if (
      session.actorType === EditorActorType.USER &&
      (!session.userId ||
        !session.user ||
        session.user.status !== UserStatus.ACTIVE)
    )
      throw new NotFoundException('Editor resource not found');
    const capabilities = await this.sessionCapabilities(
      session.actorType,
      session.userId,
      session.file.nodeId,
      session.file.node.generalAccessRole,
    );
    if (
      !capabilities?.has(DocumentCapability.VIEW) ||
      !(session.mode === EditorMode.EDIT
        ? capabilities.has(DocumentCapability.EDIT)
        : capabilities.has(DocumentCapability.PREVIEW))
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
        payload.status === 4,
      );
      // A retried save is acknowledged only after its durable result can be
      // identified. This also permits a CLOSED finalized session to absorb
      // ONLYOFFICE's callback retries.
      if (session.finalizedFileVersionId) return { error: 0 };
      if (payload.status === 1) {
        return { error: 0 };
      }
      if (payload.status === 4) {
        // ONLYOFFICE status 4 means the editor closed without changed content.
        // It is terminal and never creates a FileVersion. If a previous
        // status-2 callback already durably staged bytes, keep the session
        // eligible so that callback's retry can finish its save.
        if (!session.stagedArtifactId) {
          await this.database.prisma.editorSession.updateMany({
            where: {
              id: session.id,
              status: EditorSessionStatus.ACTIVE,
              finalizedFileVersionId: null,
            },
            data: { status: EditorSessionStatus.CLOSED, closedAt: new Date() },
          });
        }
        return { error: 0 };
      }
      if (payload.status === 3 || payload.status === 7) return { error: 1 };
      // Forcesave callbacks are recovery checkpoints, never immutable version
      // events. This implementation deliberately does not stage them.
      if (payload.status === 6) return { error: 0 };
      if (payload.status !== 2) return { error: 0 };
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
    allowNoChangeClosed = false,
  ) {
    const session = await this.database.prisma.editorSession.findFirst({
      where: {
        id: sessionId,
        baseVersionId,
        mode: EditorMode.EDIT,
      },
      select: {
        id: true,
        baseVersionId: true,
        documentKey: true,
        actorType: true,
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
            node: {
              select: { trashOperationId: true, generalAccessRole: true },
            },
          },
        },
        user: { select: { status: true } },
      },
    });
    if (!session || (key !== undefined && key !== session.documentKey))
      throw new CallbackFailure();
    if (session.finalizedFileVersionId) return session;
    if (allowNoChangeClosed && session.status === EditorSessionStatus.CLOSED)
      return session;
    if (
      !this.isCallbackEligible(session) ||
      session.file.node.trashOperationId !== null ||
      session.file.currentVersionId !== session.baseVersionId
    )
      throw new CallbackFailure();
    if (
      session.actorType === EditorActorType.USER &&
      (!session.userId ||
        !session.user ||
        session.user.status !== UserStatus.ACTIVE)
    )
      throw new CallbackFailure();
    const capabilities = await this.sessionCapabilities(
      session.actorType,
      session.userId,
      session.file.nodeId,
      session.file.node.generalAccessRole,
    );
    if (
      !capabilities?.has(DocumentCapability.VIEW) ||
      !capabilities.has(DocumentCapability.EDIT)
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
    const stagedKey = this.stagedKey(session.id, artifactId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(source, {
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new CallbackFailure();
      const hash = createHash('sha256');
      let size = 0n;
      const maximumBytes = BigInt(this.storage.uploadMaxBytes);
      async function* checkedBytes() {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += BigInt(bytes.length);
          if (size > maximumBytes) throw new CallbackFailure();
          hash.update(bytes);
          yield bytes;
        }
      }
      // Stream the ONLYOFFICE response directly into an immutable staged
      // storage object. Its writer flushes a sibling temp file and atomically
      // publishes the completed stage, so finalization needs no second copy.
      await this.objectStorage.putStream(
        stagedKey,
        Readable.from(checkedBytes()),
      );
      const staged = await this.database.prisma.editorSession.updateMany({
        where: {
          id: session.id,
          status: EditorSessionStatus.ACTIVE,
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
      if (staged.count !== 1) await this.objectStorage.delete(stagedKey);
    } catch (error) {
      await this.objectStorage.delete(stagedKey).catch(() => undefined);
      throw error instanceof CallbackFailure ? error : new CallbackFailure();
    } finally {
      clearTimeout(timer);
    }
  }

  private async finalizeStagedDocument(sessionId: string): Promise<void> {
    let finalization = this.finalizationsInFlight.get(sessionId);
    if (!finalization) {
      finalization = this.finalizeStagedDocumentOnce(sessionId);
      this.finalizationsInFlight.set(sessionId, finalization);
    }
    try {
      await finalization;
    } finally {
      if (this.finalizationsInFlight.get(sessionId) === finalization)
        this.finalizationsInFlight.delete(sessionId);
    }
  }

  private async finalizeStagedDocumentOnce(sessionId: string): Promise<void> {
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

    const stagedKey = this.stagedKey(sessionId, staged.stagedArtifactId);

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
      if (
        (await this.objectStorage.stat(stagedKey)).sizeBytes !==
        staged.stagedSizeBytes
      )
        throw new CallbackFailure();
      await this.objectStorage.promote(stagedKey, storageKey);

      const finalized = await this.database.prisma.$transaction((transaction) =>
        this.commitEditorVersion(
          transaction,
          sessionId,
          versionId,
          storageKey!,
        ),
      );
      if (finalized.created) {
        await this.objectStorage.delete(stagedKey).catch(() => {
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
      // A concurrent callback may have committed and removed the staging
      // object before this invocation reached promotion.
      const winner = await this.database.prisma.editorSession
        .findUnique({
          where: { id: sessionId },
          select: { finalizedFileVersionId: true },
        })
        .catch(() => null);
      if (winner?.finalizedFileVersionId) return;
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
        actorType: true,
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
            node: {
              select: { trashOperationId: true, generalAccessRole: true },
            },
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
      !session.stagedArtifactId ||
      !session.stagedSha256 ||
      session.stagedSizeBytes === null ||
      session.file.node.trashOperationId !== null
    )
      throw new CallbackFailure();
    if (
      session.actorType === EditorActorType.USER &&
      (!session.userId || session.user?.status !== UserStatus.ACTIVE)
    )
      throw new CallbackFailure();
    const capabilities = await this.sessionCapabilities(
      session.actorType,
      session.userId,
      session.file.nodeId,
      session.file.node.generalAccessRole,
      transaction,
    );
    if (
      !capabilities?.has(DocumentCapability.VIEW) ||
      !capabilities.has(DocumentCapability.EDIT)
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
        actorType:
          session.actorType === EditorActorType.PUBLIC
            ? AuditActorType.PUBLIC
            : AuditActorType.USER,
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
          editorSessionId: session.id,
          editorActorType: session.actorType,
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

  private stagedKey(sessionId: string, artifactId: string): string {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        artifactId,
      )
    )
      throw new CallbackFailure();
    return `tmp/editor/${sessionId}/${artifactId}`;
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
