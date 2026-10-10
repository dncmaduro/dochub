import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  DriveCreationOperationStatus,
  DriveNativeDocumentKind,
  DriveFileLocation,
  DriveSourceStatus,
  DriveFileType,
  DriveSyncStatus,
  Prisma,
  UserStatus,
} from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import {
  DRIVE_CONFIG,
  type DriveCreationTarget,
  type DriveConfig,
} from './drive.config.js';
import {
  DRIVE_PROVIDER,
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  DriveProviderError,
  type DriveApiFile,
  type DriveFilePage,
  type DriveOAuthTokens,
  type DriveProvider,
} from './google-drive.provider.js';
import { DriveCreationTargetService } from './drive-creation-target.service.js';
import type { Readable } from 'node:stream';
import { canManageDocuments } from '../common/system-role-policy.js';
import { canAdministerAccounts } from '../common/system-role-policy.js';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import {
  CreateNativeDocumentDto,
  NativeDocumentKind,
  NativeDocumentLocale,
} from './dto/create-native-document.dto.js';
import { DriveOAuthStateService } from './drive-oauth-state.service.js';
import { DriveTokenCryptoService } from './drive-token-crypto.service.js';
import { normalizeNodeName } from '../nodes/node-name.js';

const DRIVE_PAGE_SIZE = 100;
const MAX_API_PAGE_SIZE = 100;
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60_000;

const NATIVE_DOCUMENTS = {
  [NativeDocumentKind.DOCUMENT]: {
    mimeType: 'application/vnd.google-apps.document',
    names: {
      [NativeDocumentLocale.EN]: 'Untitled document',
      [NativeDocumentLocale.VI]: 'Tài liệu chưa đặt tên',
    },
  },
  [NativeDocumentKind.SPREADSHEET]: {
    mimeType: 'application/vnd.google-apps.spreadsheet',
    names: {
      [NativeDocumentLocale.EN]: 'Untitled spreadsheet',
      [NativeDocumentLocale.VI]: 'Bảng tính chưa đặt tên',
    },
  },
  [NativeDocumentKind.PRESENTATION]: {
    mimeType: 'application/vnd.google-apps.presentation',
    names: {
      [NativeDocumentLocale.EN]: 'Untitled presentation',
      [NativeDocumentLocale.VI]: 'Bản trình bày chưa đặt tên',
    },
  },
} as const;

type CreationOperation = {
  idempotencyKey: string;
  userId: string;
  kind: DriveNativeDocumentKind;
  parentId: string | null;
  locale: string;
  name: string;
  status: DriveCreationOperationStatus;
  driveFileId: string | null;
  nodeId: string | null;
  errorMessage: string | null;
};

export interface DriveIntegrationView {
  connected: boolean;
  id?: string;
  googleAccountId?: string | null;
  googleEmail?: string | null;
  connectedAt?: Date | null;
  updatedAt?: Date;
  syncStatus: DriveSyncStatus;
  lastSyncStartedAt?: Date | null;
  lastSyncCompletedAt?: Date | null;
  lastSyncError?: string | null;
  revokedAt?: Date | null;
  authorizedScopes: string[];
  canRead: boolean;
  canWrite: boolean;
  needsReauthorization: boolean;
  sharedDriveId?: string | null;
  sharedDriveName?: string | null;
  storageFolderId?: string | null;
  storageFolderName?: string | null;
  configured?: boolean;
}

export interface WritableDriveContext {
  accessToken: string;
  integrationId: string;
  target: DriveCreationTarget;
}

export type DriveAuthorizationMode = 'READ' | 'WRITE';

export interface DriveFileView {
  id: string;
  driveFileId: string;
  name: string;
  mimeType: string;
  normalizedType: DriveFileType;
  webViewLink: string | null;
  driveModifiedTime: Date | null;
  driveCreatedTime: Date | null;
  trashed: boolean;
  driveParents: string[];
  location: DriveFileLocation;
  sharedDriveId: string | null;
  sizeBytes: string | null;
  syncedAt: Date;
  sourceStatus: DriveSourceStatus;
  docsHubNodeId: string | null;
}

export interface DriveFileListOptions {
  limit?: number;
  cursor?: string;
  q?: string;
}

export interface DriveFileListView {
  items: DriveFileView[];
  nextCursor: string | null;
}

export interface DriveAuthorizationStart {
  authorizationUrl: string;
  cookieValue: string;
}

interface DriveCursor {
  name: string;
  id: string;
}

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: DriveTokenCryptoService,
    private readonly oauthState: DriveOAuthStateService,
    @Inject(DRIVE_PROVIDER) private readonly provider: DriveProvider,
    @Inject(DRIVE_CONFIG) private readonly config: DriveConfig,
    private readonly creationTarget: DriveCreationTargetService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async beginAuthorization(
    userId: string,
    mode: DriveAuthorizationMode = 'READ',
  ): Promise<DriveAuthorizationStart> {
    this.assertEnabled();
    await this.assertActiveUser(userId);
    await this.assertAdmin(userId);
    const state = this.oauthState.create(userId);
    const codeChallenge = await this.oauthState.codeChallenge(
      state.codeVerifier,
    );
    return {
      authorizationUrl: this.provider.authorizationUrl({
        state: state.state,
        codeChallenge,
        scopes:
          mode === 'WRITE'
            ? [GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_FILE_SCOPE]
            : [GOOGLE_DRIVE_READONLY_SCOPE],
      }),
      cookieValue: state.cookieValue,
    };
  }

  async completeAuthorization(input: {
    cookieValue: string;
    state: string;
    code: string;
  }): Promise<void> {
    this.assertEnabled();
    const state = this.oauthState.read(input.cookieValue, input.state);
    await this.assertActiveUser(state.userId);
    await this.assertAdmin(state.userId);
    const exchanged = await this.provider.exchangeCode({
      code: input.code,
      codeVerifier: state.codeVerifier,
    });
    const account = await this.provider.getAccount(exchanged.accessToken);
    const current = await this.database.prisma.googleDriveIntegration.findUnique({
      where: { singletonKey: 'company' },
      select: {
        id: true,
        refreshTokenEncrypted: true,
        connectedAt: true,
        authorizedScopes: true,
      },
    });
    const refreshToken =
      exchanged.refreshToken ??
      (current?.refreshTokenEncrypted
        ? this.crypto.decrypt(current.refreshTokenEncrypted)
        : undefined);
    if (!refreshToken) {
      throw new UnauthorizedException(
        'Google did not grant an offline Drive connection. Please try again.',
      );
    }

    const data = {
      googleAccountId: account.googleAccountId,
      googleEmail: account.email,
      accessTokenEncrypted: this.crypto.encrypt(exchanged.accessToken),
      refreshTokenEncrypted: this.crypto.encrypt(refreshToken),
      accessTokenExpiresAt: exchanged.expiresAt,
      revokedAt: null,
      lastSyncError: null,
      authorizedScopes: exchanged.scopes?.length
        ? exchanged.scopes
        : current?.authorizedScopes?.length
          ? current.authorizedScopes
          : [GOOGLE_DRIVE_READONLY_SCOPE],
    };
    const connection = await this.database.prisma.googleDriveIntegration.upsert({
      where: { singletonKey: 'company' },
      create: { singletonKey: 'company', connectedAt: new Date(), ...data },
      update: { ...data, connectedAt: current?.connectedAt ?? new Date() },
      select: { id: true },
    });
    await this.database.prisma.driveFile.updateMany({
      where: { driveIntegrationId: connection.id, trashed: false },
      data: { sourceStatus: DriveSourceStatus.STALE },
    });
    await this.database.prisma.driveFile.updateMany({
      where: { driveIntegrationId: connection.id, trashed: true },
      data: { sourceStatus: DriveSourceStatus.UNAVAILABLE },
    });
    await this.audit(
      state.userId,
      'DRIVE_INTEGRATION_CONNECTED',
      connection.id,
      AuditResult.SUCCESS,
      { scopes: data.authorizedScopes },
    );
  }

  async getIntegration(_userId: string): Promise<DriveIntegrationView> {
    const connection = await this.database.prisma.googleDriveIntegration.findUnique({
      where: { singletonKey: 'company' },
      select: {
        id: true,
        googleAccountId: true,
        googleEmail: true,
        connectedAt: true,
        updatedAt: true,
        syncStatus: true,
        lastSyncStartedAt: true,
        lastSyncCompletedAt: true,
        lastSyncError: true,
        revokedAt: true,
        authorizedScopes: true,
        refreshTokenEncrypted: true,
        sharedDriveId: true,
        sharedDriveName: true,
        storageFolderId: true,
        storageFolderName: true,
      },
    });
    if (!connection) {
      return {
        connected: false,
        syncStatus: DriveSyncStatus.NEVER_SYNCED,
        authorizedScopes: [],
        canRead: false,
        canWrite: false,
        needsReauthorization: false,
        configured: false,
      };
    }
    const connected =
      connection.revokedAt === null && Boolean(connection.refreshTokenEncrypted);
    const canRead =
      connected && connection.authorizedScopes.includes(GOOGLE_DRIVE_READONLY_SCOPE);
    const canWrite =
      connected && connection.authorizedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE);
    return {
      id: connection.id,
      googleAccountId: connection.googleAccountId,
      googleEmail: connection.googleEmail,
      connectedAt: connection.connectedAt,
      updatedAt: connection.updatedAt,
      syncStatus: connection.syncStatus,
      lastSyncStartedAt: connection.lastSyncStartedAt,
      lastSyncCompletedAt: connection.lastSyncCompletedAt,
      lastSyncError: connection.lastSyncError,
      revokedAt: connection.revokedAt,
      authorizedScopes: connection.authorizedScopes,
      sharedDriveId: connection.sharedDriveId,
      sharedDriveName: connection.sharedDriveName,
      storageFolderId: connection.storageFolderId,
      storageFolderName: connection.storageFolderName,
      connected,
      canRead,
      canWrite,
      needsReauthorization: connected && (!canRead || !canWrite),
      configured: Boolean(connection.sharedDriveId) && canRead,
    };
  }

  async configureSharedDrive(
    adminUserId: string,
    sharedDriveId: string,
    storageFolderId?: string,
  ): Promise<DriveIntegrationView> {
    this.assertEnabled();
    await this.assertAdmin(adminUserId);
    const integration = await this.requireReadableConnected(adminUserId, {
      requireSharedDrive: false,
    });
    const sharedDrives = await this.listSharedDrivesWithSafeErrors(integration);
    const sharedDrive = sharedDrives.find((item) => item.id === sharedDriveId);
    if (!sharedDrive) {
      throw new NotFoundException('The selected Shared Drive is not available.');
    }

    let storageFolderName: string | null = null;
    if (storageFolderId) {
      const folder = await this.withAccessToken(integration, (accessToken) =>
        this.provider.getFile(accessToken, storageFolderId),
      );
      if (
        folder.driveId !== sharedDriveId ||
        folder.mimeType !== 'application/vnd.google-apps.folder'
      ) {
        throw new ConflictException(
          'The configured storage folder must belong to the selected Shared Drive.',
        );
      }
      storageFolderName = folder.name?.trim() || null;
    }

    await this.database.prisma.googleDriveIntegration.update({
      where: { id: integration.id },
      data: {
        sharedDriveId,
        sharedDriveName: sharedDrive.name ?? null,
        storageFolderId: storageFolderId ?? null,
        storageFolderName,
        lastSyncError: null,
      },
    });
    await this.audit(
      adminUserId,
      'DRIVE_SHARED_DRIVE_CONFIGURED',
      integration.id,
      AuditResult.SUCCESS,
      { sharedDriveId, storageFolderId: storageFolderId ?? null },
    );
    return this.getIntegration(adminUserId);
  }

  async listSharedDrives(adminUserId: string) {
    this.assertEnabled();
    await this.assertAdmin(adminUserId);
    const integration = await this.requireReadableConnected(adminUserId, {
      requireSharedDrive: false,
    });
    return this.listSharedDrivesWithSafeErrors(integration);
  }

  async disconnect(userId: string): Promise<DriveIntegrationView> {
    await this.assertAdmin(userId);
    const connection = await this.database.prisma.googleDriveIntegration.findUnique({
      where: { singletonKey: 'company' },
      select: { id: true },
    });
    if (!connection) return this.getIntegration(userId);

    const updated = await this.database.prisma.googleDriveIntegration.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: null,
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        revokedAt: new Date(),
        lastSyncError: 'Google Drive is disconnected.',
        syncStatus: DriveSyncStatus.FAILED,
      },
      select: { id: true },
    });
    await this.database.prisma.driveFile.updateMany({
      where: {
        driveIntegrationId: updated.id,
        sourceStatus: { not: DriveSourceStatus.UNAVAILABLE },
      },
      data: { sourceStatus: DriveSourceStatus.STALE },
    });
    await this.audit(
      userId,
      'DRIVE_INTEGRATION_DISCONNECTED',
      updated.id,
      AuditResult.SUCCESS,
      {},
    );
    return this.getIntegration(userId);
  }

  async sync(userId: string): Promise<DriveIntegrationView> {
    this.assertEnabled();
    await this.assertAdmin(userId);
    const connection = await this.requireReadableConnected(userId);
    const now = new Date();
    const claimed = await this.database.prisma.googleDriveIntegration.updateMany({
      where: {
        id: connection.id,
        revokedAt: null,
        syncStatus: { not: DriveSyncStatus.SYNCING },
      },
      data: {
        syncStatus: DriveSyncStatus.SYNCING,
        lastSyncStartedAt: now,
        lastSyncError: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException('A Google Drive sync is already running.');
    }
    await this.audit(
      userId,
      'DRIVE_SYNC_STARTED',
      connection.id,
      AuditResult.SUCCESS,
      {},
    );

    let synchronizedFiles = 0;
    try {
      const latest =
        await this.database.prisma.googleDriveIntegration.findUniqueOrThrow({
          where: { id: connection.id },
          select: {
            id: true,
            accessTokenEncrypted: true,
            accessTokenExpiresAt: true,
            refreshTokenEncrypted: true,
          },
        });
      await this.withAccessToken(latest, async (accessToken) => {
        synchronizedFiles = await this.syncProviderFiles(
          connection.id,
          connection.sharedDriveId!,
          accessToken,
        );
      });
      await this.database.prisma.googleDriveIntegration.update({
        where: { id: connection.id },
        data: {
          syncStatus: DriveSyncStatus.SYNCED,
          lastSyncCompletedAt: new Date(),
          lastSyncError: null,
        },
      });
      await this.audit(
        userId,
        'DRIVE_SYNC_COMPLETED',
        connection.id,
        AuditResult.SUCCESS,
        { synchronizedFiles },
      );
    } catch (error) {
      const message = this.safeDriveError(error);
      const authorizationRevoked =
        error instanceof DriveProviderError && error.kind === 'unauthorized';
      await this.database.prisma.googleDriveIntegration.update({
        where: { id: connection.id },
        data: {
          syncStatus: DriveSyncStatus.FAILED,
          lastSyncError: message,
          revokedAt: authorizationRevoked ? new Date() : undefined,
        },
      });
      if (authorizationRevoked) {
        await this.database.prisma.driveFile.updateMany({
          where: {
            driveIntegrationId: connection.id,
            sourceStatus: { not: DriveSourceStatus.UNAVAILABLE },
          },
          data: { sourceStatus: DriveSourceStatus.STALE },
        });
      }
      await this.audit(
        userId,
        'DRIVE_SYNC_FAILED',
        connection.id,
        AuditResult.FAILED,
        { error: message },
      );
      this.logger.warn(
        `Drive metadata sync failed for company integration ${connection.id}: ${message}`,
      );
      throw new ConflictException(message);
    }
    return this.getIntegration(userId);
  }

  async listFiles(
    userId: string,
    options: DriveFileListOptions,
  ): Promise<DriveFileListView> {
    const connection = await this.requireReadableConnected(userId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_API_PAGE_SIZE);
    const cursor = options.cursor ? this.decodeCursor(options.cursor) : null;
    const query = options.q?.trim();
    const files = await this.database.prisma.driveFile.findMany({
      where: {
        driveIntegrationId: connection.id,
        trashed: false,
        sourceStatus: { not: DriveSourceStatus.UNAVAILABLE },
        ...(query ? { name: { contains: query, mode: 'insensitive' } } : {}),
        ...(cursor
          ? {
              OR: [
                { name: { gt: cursor.name } },
                { name: cursor.name, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        driveFileId: true,
        name: true,
        mimeType: true,
        normalizedType: true,
        webViewLink: true,
        driveModifiedTime: true,
        driveCreatedTime: true,
        trashed: true,
        driveParents: true,
        location: true,
        sharedDriveId: true,
        sizeBytes: true,
        syncedAt: true,
        sourceStatus: true,
        docsHubFile: { select: { nodeId: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const hasNext = files.length > limit;
    const page = files.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((file) => this.fileView(file)),
      nextCursor: hasNext && last ? this.encodeCursor(last) : null,
    };
  }

  async createNativeFile(
    userId: string,
    request: { name: string; mimeType: string },
  ): Promise<{ integrationId: string; file: DriveApiFile }> {
    this.assertEnabled();
    const connection = await this.requireWritableConnected(userId);
    const target = this.creationTarget.resolve(connection);
    const file = await this.withAccessToken(connection, (accessToken) =>
      this.provider.createNativeFile(accessToken, {
        name: request.name,
        mimeType: request.mimeType,
        parentFolderId: target.parentFolderId,
      }),
    );
    return { integrationId: connection.id, file };
  }

  async createNativeDocument(
    actorUserId: string,
    dto: CreateNativeDocumentDto,
    idempotencyKey?: string,
  ) {
    this.assertEnabled();
    await this.authorization.assertDocumentManager(actorUserId);
    const key = idempotencyKey?.trim();
    if (!key || key.length > 200) {
      throw new BadRequestException(
        'A valid Idempotency-Key header is required',
      );
    }
    await this.requireWritableConnected(actorUserId);

    const kind = dto.kind as NativeDocumentKind;
    const definition = NATIVE_DOCUMENTS[kind];
    const locale = dto.locale ?? NativeDocumentLocale.EN;
    const parentId = dto.parentId ?? null;
    if (!definition)
      throw new BadRequestException('Unsupported native document kind');

    const { operation, isNew } = await this.beginCreationOperation(
      actorUserId,
      key,
      kind,
      parentId,
      locale,
      definition.names[locale],
    );
    if (operation.userId !== actorUserId) {
      throw new ConflictException('The Idempotency-Key is already in use');
    }
    if (
      !isNew &&
      operation.status === DriveCreationOperationStatus.IN_PROGRESS
    ) {
      throw new ConflictException(
        'This native document creation is already in progress',
      );
    }
    if (operation.status === DriveCreationOperationStatus.SUCCEEDED) {
      return this.creationResponse(operation.idempotencyKey);
    }
    if (operation.status === DriveCreationOperationStatus.FAILED) {
      throw new ConflictException(
        operation.errorMessage ??
          'This native document creation has already failed',
      );
    }

    let created: { integrationId: string; file: DriveApiFile } | undefined;
    try {
      created = await this.createNativeFile(actorUserId, {
        name: operation.name,
        mimeType: definition.mimeType,
      });
      return await this.registerNativeDocument(
        actorUserId,
        operation,
        created.integrationId,
        created.file,
        kind,
        parentId,
      );
    } catch (error) {
      const message = this.creationFailureMessage(error);
      if (!created?.file.id) {
        await this.markCreationFailed(operation.idempotencyKey, message);
        throw error;
      }
      try {
        await this.deleteNativeFile(actorUserId, created.file.id);
        await this.markCreationFailed(
          operation.idempotencyKey,
          'Native document creation failed; the Google Drive file was removed.',
        );
      } catch (compensationError) {
        await this.markCreationFailed(
          operation.idempotencyKey,
          'Google Drive created a file that Docs Hub could not register; manual reconciliation is required.',
        );
        await this.audit(
          actorUserId,
          'GOOGLE_DRIVE_DOCUMENT_ORPHANED',
          null,
          AuditResult.FAILED,
          {
            operationId: operation.idempotencyKey,
            driveFileId: created.file.id,
            error: message,
            compensationError: this.creationFailureMessage(compensationError),
          },
        );
        throw new ServiceUnavailableException(
          `Google Drive created a file that Docs Hub could not register. Reconcile Drive file ${created.file.id}.`,
        );
      }
      throw new ConflictException(
        'Native document creation failed; the Google Drive file was removed.',
      );
    }
  }

  async deleteNativeFile(userId: string, driveFileId: string): Promise<void> {
    this.assertEnabled();
    const connection = await this.requireConnected(userId);
    await this.withAccessToken(connection, (accessToken) =>
      this.provider.deleteFile(accessToken, driveFileId),
    );
  }

  /** Runs a Drive write using server-held OAuth credentials and the configured physical target. */
  async withWritableDrive<T>(
    userId: string,
    operation: (context: WritableDriveContext) => Promise<T>,
  ): Promise<T> {
    this.assertEnabled();
    await this.assertWriteManager(userId);
    let connection;
    try {
      connection = await this.requireWritableConnected(userId);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw this.writeAuthorizationRequired();
      }
      throw error;
    }
    // Upload streams are one-shot. Refresh before opening a resumable session,
    // but do not replay the callback after a provider 401 and reuse a consumed
    // request stream.
    const accessToken = await this.accessToken(connection);
    return operation({
      accessToken,
      integrationId: connection.id,
      target: this.creationTarget.resolve(connection),
    });
  }

  /** Uses the company integration for system-owned Phase 4A work. */
  async withConfiguredWritableDrive<T>(
    operation: (context: WritableDriveContext) => Promise<T>,
  ): Promise<T> {
    this.assertEnabled();
    const connection = await this.requireWritableConnected('system');
    const accessToken = await this.accessToken(connection);
    return operation({
      accessToken,
      integrationId: connection.id,
      target: this.creationTarget.resolve(connection),
    });
  }

  assertDriveUploadManager(userId: string): Promise<void> {
    return this.assertWriteManager(userId);
  }

  uploadBinaryWithContext(
    context: WritableDriveContext,
    name: string,
    mimeType: string,
    source: Readable,
    signal?: AbortSignal,
  ): Promise<DriveApiFile> {
    return this.provider.uploadBinaryFile(
      context.accessToken,
      {
        name,
        mimeType,
        ...(context.target.parentFolderId
          ? { parentFolderId: context.target.parentFolderId }
          : {}),
      },
      source,
      signal,
    );
  }

  deleteBinaryWithContext(
    context: WritableDriveContext,
    driveFileId: string,
  ): Promise<void> {
    return this.provider.deleteFile(context.accessToken, driveFileId);
  }

  getFileWithContext(
    context: WritableDriveContext,
    driveFileId: string,
  ): Promise<DriveApiFile> {
    return this.provider.getFile(context.accessToken, driveFileId);
  }

  private async beginCreationOperation(
    userId: string,
    idempotencyKey: string,
    kind: NativeDocumentKind,
    parentId: string | null,
    locale: NativeDocumentLocale,
    baseName: string,
  ): Promise<{ operation: CreationOperation; isNew: boolean }> {
    try {
      return await this.database.prisma.$transaction(async (transaction) => {
        const existing = await transaction.driveCreationOperation.findUnique({
          where: { idempotencyKey },
        });
        if (existing) return { operation: existing, isNew: false };
        await this.assertLogicalParent(transaction, parentId);
        const name = await this.nextAvailableName(
          transaction,
          parentId,
          baseName,
        );
        const operation = await transaction.driveCreationOperation.create({
          data: {
            idempotencyKey,
            userId,
            kind: kind as DriveNativeDocumentKind,
            parentId,
            locale,
            name,
          },
        });
        return { operation, isNew: true };
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const existing =
        await this.database.prisma.driveCreationOperation.findUnique({
          where: { idempotencyKey },
        });
      if (!existing) throw error;
      return { operation: existing, isNew: false };
    }
  }

  private async registerNativeDocument(
    actorUserId: string,
    operation: CreationOperation,
    integrationId: string,
    remoteFile: DriveApiFile,
    kind: NativeDocumentKind,
    parentId: string | null,
  ) {
    const normalizedRemoteFile: DriveApiFile = {
      ...remoteFile,
      name: remoteFile.name?.trim() || operation.name,
      mimeType: remoteFile.mimeType ?? NATIVE_DOCUMENTS[kind].mimeType,
    };
    await this.database.prisma.$transaction(
      async (transaction) => {
        await this.assertLogicalParent(transaction, parentId);
        const conflict = await transaction.node.findFirst({
          where: {
            parentId,
            normalizedName: normalizeNodeName(operation.name).normalizedName,
            trashOperationId: null,
          },
          select: { id: true },
        });
        if (conflict) {
          throw new ConflictException('A node with this name already exists');
        }
        const storedDriveFile = await transaction.driveFile.upsert({
          where: { driveFileId: normalizedRemoteFile.id },
          create: this.fileData(integrationId, normalizedRemoteFile),
          update: this.fileData(integrationId, normalizedRemoteFile),
          select: { id: true },
        });
        const logicalName = normalizeNodeName(operation.name);
        const node = await transaction.node.create({
          data: {
            parentId,
            type: 'FILE',
            name: logicalName.name,
            normalizedName: logicalName.normalizedName,
            createdById: actorUserId,
            updatedById: actorUserId,
          },
          select: { id: true },
        });
        await transaction.file.create({
          data: {
            nodeId: node.id,
            backingType: 'GOOGLE_DRIVE',
            driveFileId: storedDriveFile.id,
          },
          select: { id: true },
        });
        await transaction.driveCreationOperation.update({
          where: { idempotencyKey: operation.idempotencyKey },
          data: {
            status: DriveCreationOperationStatus.SUCCEEDED,
            driveFileId: normalizedRemoteFile.id,
            nodeId: node.id,
            errorMessage: null,
          },
        });
        await transaction.auditLog.create({
          data: {
            actorType: AuditActorType.USER,
            actorId: actorUserId,
            action: 'GOOGLE_DRIVE_DOCUMENT_CREATED',
            resourceType: 'NODE',
            resourceId: node.id,
            result: AuditResult.SUCCESS,
            metadata: {
              driveFileId: storedDriveFile.id,
              nodeId: node.id,
              kind,
              parentId,
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return this.creationResponse(operation.idempotencyKey);
  }

  private async creationResponse(idempotencyKey: string) {
    const operation =
      await this.database.prisma.driveCreationOperation.findUnique({
        where: { idempotencyKey },
      });
    if (!operation?.nodeId) {
      throw new ConflictException('Native document creation is not complete');
    }
    const node = await this.database.prisma.node.findUnique({
      where: { id: operation.nodeId },
      select: {
        id: true,
        parentId: true,
        name: true,
        file: {
          select: {
            id: true,
            driveFile: {
              select: {
                driveFileId: true,
                webViewLink: true,
                driveModifiedTime: true,
              },
            },
          },
        },
      },
    });
    if (!node?.file?.driveFile) {
      throw new ConflictException('Native document creation is not complete');
    }
    return {
      operationId: operation.idempotencyKey,
      kind: operation.kind,
      nodeId: node.id,
      fileId: node.file.id,
      driveFileId: node.file.driveFile.driveFileId,
      parentId: node.parentId,
      name: node.name,
      webViewLink: node.file.driveFile.webViewLink,
      driveModifiedTime: node.file.driveFile.driveModifiedTime,
    };
  }

  private async assertLogicalParent(
    client: Prisma.TransactionClient | typeof this.database.prisma,
    parentId: string | null,
  ): Promise<void> {
    if (!parentId) return;
    const parent = await client.node.findFirst({
      where: { id: parentId, type: 'FOLDER', trashOperationId: null },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('Destination folder not found');
  }

  private async nextAvailableName(
    client: Prisma.TransactionClient | typeof this.database.prisma,
    parentId: string | null,
    baseName: string,
  ): Promise<string> {
    const normalizedBase = normalizeNodeName(baseName);
    if (
      !(await this.nodeNameExists(
        client,
        parentId,
        normalizedBase.normalizedName,
      ))
    ) {
      return normalizedBase.name;
    }
    for (let index = 1; index <= 1000; index += 1) {
      const candidate = normalizeNodeName(`${normalizedBase.name} (${index})`);
      if (
        !(await this.nodeNameExists(client, parentId, candidate.normalizedName))
      ) {
        return candidate.name;
      }
    }
    throw new ConflictException('Unable to allocate a unique document name');
  }

  private async nodeNameExists(
    client: Prisma.TransactionClient | typeof this.database.prisma,
    parentId: string | null,
    normalizedName: string,
  ): Promise<boolean> {
    return Boolean(
      await client.node.findFirst({
        where: { parentId, normalizedName, trashOperationId: null },
        select: { id: true },
      }),
    );
  }

  private async markCreationFailed(
    idempotencyKey: string,
    errorMessage: string,
  ): Promise<void> {
    await this.database.prisma.driveCreationOperation.updateMany({
      where: {
        idempotencyKey,
        status: DriveCreationOperationStatus.IN_PROGRESS,
      },
      data: { status: DriveCreationOperationStatus.FAILED, errorMessage },
    });
  }

  private creationFailureMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return 'Native Google Workspace document creation failed.';
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private async syncProviderFiles(
    integrationId: string,
    sharedDriveId: string,
    accessToken: string,
  ): Promise<number> {
    let count = 0;
    const seenDriveFileIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const page = await this.provider.listFiles(accessToken, {
        pageToken,
        pageSize: DRIVE_PAGE_SIZE,
        includeTrashed: true,
        driveId: sharedDriveId,
      });
      count += await this.upsertPage(integrationId, page, seenDriveFileIds);
      pageToken = page.nextPageToken;
    } while (pageToken);
    await this.database.prisma.driveFile.updateMany({
      where: {
        driveIntegrationId: integrationId,
        ...(seenDriveFileIds.size > 0
          ? { driveFileId: { notIn: [...seenDriveFileIds] } }
          : {}),
      },
      data: { sourceStatus: DriveSourceStatus.UNAVAILABLE },
    });
    return count;
  }

  private async upsertPage(
    integrationId: string,
    page: DriveFilePage,
    seenDriveFileIds: Set<string>,
  ): Promise<number> {
    let count = 0;
    for (const file of page.files) {
      if (!file.id) continue;
      seenDriveFileIds.add(file.id);
      const stored = await this.database.prisma.driveFile.upsert({
        where: { driveFileId: file.id },
        create: this.fileData(integrationId, file),
        update: this.fileData(integrationId, file),
      });
      await this.mirrorLinkedNodeName(
        stored.id,
        file.name?.trim() || '(unnamed Drive file)',
      );
      count += 1;
    }
    return count;
  }

  private async mirrorLinkedNodeName(
    driveFileId: string,
    externalName: string,
  ): Promise<void> {
    const linked = await this.database.prisma.file.findUnique({
      where: { driveFileId },
      select: {
        nodeId: true,
        node: { select: { parentId: true } },
      },
    });
    if (!linked) return;
    const name = normalizeNodeName(externalName);
    const conflict = await this.database.prisma.node.findFirst({
      where: {
        id: { not: linked.nodeId },
        parentId: linked.node.parentId,
        normalizedName: name.normalizedName,
        trashOperationId: null,
      },
      select: { id: true },
    });
    if (conflict) return;
    await this.database.prisma.node.update({
      where: { id: linked.nodeId },
      data: { name: name.name, normalizedName: name.normalizedName },
    });
  }

  private fileData(integrationId: string, file: DriveApiFile) {
    return {
      driveIntegrationId: integrationId,
      driveFileId: file.id,
      name: file.name?.trim() || '(unnamed Drive file)',
      mimeType: file.mimeType ?? 'application/octet-stream',
      normalizedType: this.normalizeType(file.mimeType),
      webViewLink: file.webViewLink ?? null,
      driveModifiedTime: this.safeDate(file.modifiedTime),
      driveCreatedTime: this.safeDate(file.createdTime),
      trashed: file.trashed === true,
      driveParents: file.parents ?? [],
      location: this.location(file),
      sharedDriveId: file.driveId ?? null,
      sizeBytes: this.safeBigInt(file.size),
      driveVersion: file.version ?? null,
      sourceStatus:
        file.trashed === true
          ? DriveSourceStatus.UNAVAILABLE
          : DriveSourceStatus.CONNECTED,
      syncedAt: new Date(),
    } satisfies Prisma.DriveFileUncheckedCreateInput;
  }

  private fileView(file: {
    id: string;
    driveFileId: string;
    name: string;
    mimeType: string;
    normalizedType: DriveFileType;
    webViewLink: string | null;
    driveModifiedTime: Date | null;
    driveCreatedTime: Date | null;
    trashed: boolean;
    driveParents: string[];
    location: DriveFileLocation;
    sharedDriveId: string | null;
    sizeBytes: bigint | null;
    syncedAt: Date;
    sourceStatus: DriveSourceStatus;
    docsHubFile: { nodeId: string } | null;
  }): DriveFileView {
    return {
      id: file.id,
      driveFileId: file.driveFileId,
      name: file.name,
      mimeType: file.mimeType,
      normalizedType: file.normalizedType,
      webViewLink: file.webViewLink,
      driveModifiedTime: file.driveModifiedTime,
      driveCreatedTime: file.driveCreatedTime,
      trashed: file.trashed,
      driveParents: file.driveParents,
      location: file.location,
      sharedDriveId: file.sharedDriveId,
      sizeBytes: file.sizeBytes?.toString() ?? null,
      syncedAt: file.syncedAt,
      sourceStatus: file.sourceStatus,
      docsHubNodeId: file.docsHubFile?.nodeId ?? null,
    };
  }

  private async withAccessToken<T>(
    connection: {
      id: string;
      accessTokenEncrypted: string | null;
      accessTokenExpiresAt: Date | null;
      refreshTokenEncrypted: string | null;
    },
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.accessToken(connection);
    try {
      return await operation(accessToken);
    } catch (error) {
      if (
        !(error instanceof DriveProviderError) ||
        error.kind !== 'unauthorized'
      ) {
        throw error;
      }
      const refreshed = await this.refreshConnection(connection);
      accessToken = refreshed.accessToken;
      return operation(accessToken);
    }
  }

  private async accessToken(connection: {
    id: string;
    accessTokenEncrypted: string | null;
    accessTokenExpiresAt: Date | null;
    refreshTokenEncrypted: string | null;
  }): Promise<string> {
    if (
      connection.accessTokenEncrypted &&
      connection.accessTokenExpiresAt &&
      connection.accessTokenExpiresAt.getTime() >
        Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS
    ) {
      return this.crypto.decrypt(connection.accessTokenEncrypted);
    }
    return (await this.refreshConnection(connection)).accessToken;
  }

  private async refreshConnection(connection: {
    id: string;
    refreshTokenEncrypted: string | null;
  }): Promise<{ accessToken: string }> {
    if (!connection.refreshTokenEncrypted) {
      throw new DriveProviderError('unauthorized');
    }
    const refreshToken = this.crypto.decrypt(connection.refreshTokenEncrypted);
    let tokens: DriveOAuthTokens;
    try {
      tokens = await this.provider.refreshAccessToken(refreshToken);
    } catch (error) {
      if (
        error instanceof DriveProviderError &&
        (error.status === 400 || error.status === 401)
      ) {
        throw new DriveProviderError('unauthorized', error.status);
      }
      throw error;
    }
    await this.database.prisma.googleDriveIntegration.update({
      where: { id: connection.id },
      data: {
        accessTokenEncrypted: this.crypto.encrypt(tokens.accessToken),
        accessTokenExpiresAt: tokens.expiresAt,
        ...(tokens.refreshToken
          ? { refreshTokenEncrypted: this.crypto.encrypt(tokens.refreshToken) }
          : {}),
      },
    });
    return { accessToken: tokens.accessToken };
  }

  private async requireConnected(
    _userId: string,
    options: { requireSharedDrive?: boolean } = {},
  ) {
    const connection = await this.database.prisma.googleDriveIntegration.findUnique({
      where: { singletonKey: 'company' },
      select: {
        id: true,
        revokedAt: true,
        accessTokenEncrypted: true,
        accessTokenExpiresAt: true,
        refreshTokenEncrypted: true,
        authorizedScopes: true,
        sharedDriveId: true,
        storageFolderId: true,
      },
    });
    if (
      !connection ||
      connection.revokedAt ||
      !connection.refreshTokenEncrypted
    ) {
      throw new NotFoundException('Google Drive is not connected.');
    }
    if (options.requireSharedDrive !== false && !connection.sharedDriveId) {
      throw new ConflictException(
        'The company Shared Drive must be configured before using Google Drive.',
      );
    }
    return connection;
  }

  private async requireReadableConnected(
    userId: string,
    options: { requireSharedDrive?: boolean } = {},
  ) {
    const connection = await this.requireConnected(userId, options);
    if (!connection.authorizedScopes.includes(GOOGLE_DRIVE_READONLY_SCOPE)) {
      throw this.readAuthorizationRequired();
    }
    return connection;
  }

  private async requireWritableConnected(userId: string) {
    const connection = await this.requireConnected(userId);
    if (!connection.authorizedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)) {
      throw this.writeAuthorizationRequired();
    }
    return connection;
  }

  private writeAuthorizationRequired(): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code: 'GOOGLE_DRIVE_WRITE_AUTHORIZATION_REQUIRED',
      message: 'Google Drive write access authorization is required.',
    });
  }

  private readAuthorizationRequired(): ForbiddenException {
    return new ForbiddenException({
      statusCode: 403,
      code: 'GOOGLE_DRIVE_READ_AUTHORIZATION_REQUIRED',
      message: 'Google Drive read authorization is required.',
    });
  }

  private async assertWriteManager(userId: string): Promise<void> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, systemRole: true },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !canManageDocuments(user.systemRole)
    ) {
      throw new ForbiddenException('Document-management access is required');
    }
  }

  private async assertAdmin(userId: string): Promise<void> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, systemRole: true },
    });
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !canAdministerAccounts(user.systemRole)
    ) {
      throw new ForbiddenException('System administrator access is required');
    }
  }

  private async assertActiveUser(userId: string): Promise<void> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private assertEnabled(): void {
    if (!this.config.enabled) {
      throw new ServiceUnavailableException(
        'Google Drive integration is not configured.',
      );
    }
  }

  private async audit(
    userId: string,
    action: string,
    resourceId: string | null,
    result: AuditResult,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.database.prisma.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId: userId,
        action,
        resourceType: 'DRIVE_CONNECTION',
        resourceId,
        result,
        metadata,
      },
    });
  }

  private safeDriveError(error: unknown): string {
    if (error instanceof DriveProviderError) {
      if (error.kind === 'unauthorized')
        return 'Google Drive authorization expired or was revoked. Reconnect Google Drive.';
      if (error.kind === 'forbidden')
        return 'Google Drive denied metadata access for this account.';
      if (error.kind === 'rate_limited')
        return 'Google Drive is temporarily rate-limiting requests. Try again later.';
      if (error.kind === 'network')
        return 'Google Drive could not be reached. Try again later.';
      return 'Google Drive returned an unexpected error. Try again later.';
    }
    return 'Google Drive metadata sync failed. Previously synchronized metadata was preserved.';
  }

  private async listSharedDrivesWithSafeErrors(connection: {
    id: string;
    accessTokenEncrypted: string | null;
    accessTokenExpiresAt: Date | null;
    refreshTokenEncrypted: string | null;
  }) {
    try {
      return await this.withAccessToken(connection, (accessToken) =>
        this.listAllSharedDrives(accessToken),
      );
    } catch (error) {
      throw this.sharedDriveDiscoveryError(error);
    }
  }

  private sharedDriveDiscoveryError(error: unknown): Error {
    if (error instanceof DriveProviderError) {
      if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
        return this.readAuthorizationRequired();
      }
      if (error.kind === 'rate_limited') {
        return new ServiceUnavailableException({
          statusCode: 503,
          code: 'GOOGLE_DRIVE_RATE_LIMITED',
          message: 'Google Drive is temporarily rate-limiting requests. Try again later.',
        });
      }
      if (error.kind === 'network') {
        return new ServiceUnavailableException({
          statusCode: 503,
          code: 'GOOGLE_DRIVE_UNAVAILABLE',
          message: 'Google Drive could not be reached. Try again later.',
        });
      }
      return new BadGatewayException({
        statusCode: 502,
        code: 'GOOGLE_DRIVE_PROVIDER_ERROR',
        message: 'Google Drive returned an unexpected error. Try again later.',
      });
    }
    return new ServiceUnavailableException({
      statusCode: 503,
      code: 'GOOGLE_DRIVE_UNAVAILABLE',
      message: 'Google Drive could not be reached. Try again later.',
    });
  }

  private async listAllSharedDrives(accessToken: string) {
    const drives: Array<{ id: string; name?: string }> = [];
    let pageToken: string | undefined;
    do {
      const page = await this.provider.listSharedDrives(accessToken, pageToken);
      drives.push(...page.drives);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return drives;
  }

  private normalizeType(mimeType: string | undefined): DriveFileType {
    switch (mimeType) {
      case 'application/vnd.google-apps.folder':
        return DriveFileType.FOLDER;
      case 'application/vnd.google-apps.document':
        return DriveFileType.GOOGLE_DOC;
      case 'application/vnd.google-apps.spreadsheet':
        return DriveFileType.GOOGLE_SHEET;
      case 'application/vnd.google-apps.presentation':
        return DriveFileType.GOOGLE_SLIDE;
      case 'application/pdf':
        return DriveFileType.PDF;
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return DriveFileType.DOCX;
      case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        return DriveFileType.XLSX;
      case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
        return DriveFileType.PPTX;
      default:
        if (mimeType?.startsWith('image/')) return DriveFileType.IMAGE;
        if (mimeType?.startsWith('video/')) return DriveFileType.VIDEO;
        return DriveFileType.BINARY;
    }
  }

  private location(file: DriveApiFile): DriveFileLocation {
    if (file.driveId) return DriveFileLocation.SHARED_DRIVE;
    if (file.sharedWithMeTime && !file.ownedByMe) {
      return DriveFileLocation.SHARED_WITH_ME;
    }
    return file.ownedByMe === false
      ? DriveFileLocation.UNKNOWN
      : DriveFileLocation.MY_DRIVE;
  }

  private safeDate(value: string | undefined): Date | null {
    if (!value) return null;
    const result = new Date(value);
    return Number.isNaN(result.valueOf()) ? null : result;
  }

  private safeBigInt(value: string | undefined): bigint | null {
    if (!value || !/^\d+$/.test(value)) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private encodeCursor(value: { name: string; id: string }): string {
    return Buffer.from(
      JSON.stringify({ name: value.name, id: value.id }),
    ).toString('base64url');
  }

  private decodeCursor(value: string): DriveCursor {
    try {
      const decoded = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<DriveCursor>;
      if (typeof decoded.name !== 'string' || typeof decoded.id !== 'string') {
        throw new Error();
      }
      return { name: decoded.name, id: decoded.id };
    } catch {
      throw new ConflictException('The Drive files cursor is invalid.');
    }
  }
}
