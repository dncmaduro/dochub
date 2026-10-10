import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DriveCreationOperationStatus, DriveFileType, DriveSyncStatus, UserStatus } from '@dochub/database';
import { DriveService } from './drive.service.js';
import { DriveProviderError, GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_READONLY_SCOPE, type DriveProvider } from './google-drive.provider.js';

const LEGACY_METADATA_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.metadata.readonly';

function harness() {
  const userId = randomUUID();
  const connectionId = randomUUID();
  const connections = new Map<string, any>();
  const files = new Map<string, any>();
  const operations = new Map<string, any>();
  const nodes = new Map<string, any>();
  const auditLog: any[] = [];
  const user = { id: userId, status: UserStatus.ACTIVE, systemRole: 'ADMIN' };
  const connection = {
    id: connectionId,
    singletonKey: 'company',
    googleAccountId: 'google-account',
    googleEmail: 'drive@example.test',
    accessTokenEncrypted: 'enc:access',
    refreshTokenEncrypted: 'enc:refresh',
    accessTokenExpiresAt: new Date(Date.now() + 300_000),
    connectedAt: new Date(),
    updatedAt: new Date(),
    syncStatus: DriveSyncStatus.NEVER_SYNCED,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncError: null,
    revokedAt: null,
    authorizedScopes: [GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_FILE_SCOPE],
    sharedDriveId: null,
    sharedDriveName: null,
    storageFolderId: 'storage-folder',
    storageFolderName: 'Docs Hub storage',
  };
  connections.set('company', connection);

  const prisma = {
    user: { findUnique: vi.fn(async () => user) },
    googleDriveIntegration: {
      findUnique: vi.fn(async (args: any) => {
        const row = args.where.singletonKey ? connections.get('company') : [...connections.values()].find((item) => item.id === args.where.id);
        if (!row || !args.select) return row ?? null;
        return Object.fromEntries(Object.keys(args.select).filter((key) => args.select[key]).map((key) => [key, row[key]]));
      }),
      findUniqueOrThrow: vi.fn(async (args: any) => {
        const row = [...connections.values()].find((item) => item.id === args.where.id);
        if (!row) throw new Error('missing connection');
        return row;
      }),
      updateMany: vi.fn(async (args: any) => {
        const row = [...connections.values()].find((item) => item.id === args.where.id);
        if (!row || row.revokedAt || row.syncStatus === DriveSyncStatus.SYNCING) return { count: 0 };
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: 1 };
      }),
      update: vi.fn(async (args: any) => {
        const row = [...connections.values()].find((item) => item.id === args.where.id);
        if (!row) throw new Error('missing connection');
        Object.assign(row, args.data, { updatedAt: new Date() });
        return args.select?.id ? { id: row.id } : row;
      }),
      upsert: vi.fn(async (args: any) => {
        const row = connections.get('company') ?? { id: connectionId };
        Object.assign(row, connections.has('company') ? args.update : args.create, { updatedAt: new Date() });
        connections.set('company', row);
        return { id: row.id };
      }),
    },
    driveFile: {
      upsert: vi.fn(async (args: any) => {
        const key = args.where.driveFileId;
        const row = files.get(key) ?? { id: randomUUID() };
        Object.assign(row, files.has(key) ? args.update : args.create);
        files.set(key, row);
        return row;
      }),
      updateMany: vi.fn(async (args: any) => {
        let count = 0;
        for (const row of files.values()) {
          if (row.driveIntegrationId !== args.where.driveIntegrationId) continue;
          if (args.where.trashed !== undefined && row.trashed !== args.where.trashed) continue;
          if (args.where.driveFileId?.notIn?.includes(row.driveFileId)) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn(async () => [...files.values()].sort((a, b) => a.name.localeCompare(b.name))),
    },
    file: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: any) => {
        const file = { id: randomUUID(), ...args.data };
        const node = nodes.get(args.data.nodeId);
        const driveFile = [...files.values()].find((item) => item.id === args.data.driveFileId);
        if (node) Object.assign(node, { fileId: file.id, driveFileId: driveFile?.driveFileId ?? 'created-doc' });
        return file;
      }),
    },
    node: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(),
      create: vi.fn(async (args: any) => {
        const row = { id: randomUUID(), ...args.data };
        nodes.set(row.id, row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async (args: any) => {
        const row = nodes.get(args.where.id);
        if (!row) return null;
        return {
          id: row.id,
          parentId: row.parentId ?? null,
          name: row.name,
          file: {
            id: row.fileId ?? randomUUID(),
            driveFile: {
              driveFileId: row.driveFileId ?? 'created-doc',
              webViewLink: 'https://docs.google.com/document/d/created-doc',
              driveModifiedTime: null,
            },
          },
        };
      }),
    },
    driveCreationOperation: {
      findUnique: vi.fn(async (args: any) => operations.get(args.where.idempotencyKey) ?? null),
      create: vi.fn(async (args: any) => {
        const row = {
          ...args.data,
          status: DriveCreationOperationStatus.IN_PROGRESS,
          driveFileId: null,
          nodeId: null,
          errorMessage: null,
        };
        operations.set(row.idempotencyKey, row);
        return row;
      }),
      update: vi.fn(async (args: any) => {
        const row = operations.get(args.where.idempotencyKey);
        if (!row) throw new Error('missing operation');
        Object.assign(row, args.data);
        return row;
      }),
      updateMany: vi.fn(async (args: any) => {
        const row = operations.get(args.where.idempotencyKey);
        if (!row || row.status !== args.where.status) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }),
    },
    auditLog: { create: vi.fn(async (args: any) => auditLog.push(args.data)) },
  };
  prisma.$transaction = vi.fn(async (callback: (transaction: any) => Promise<unknown>) => callback(prisma));
  const provider: DriveProvider = {
    authorizationUrl: vi.fn(() => 'https://accounts.example.test/authorize'),
    exchangeCode: vi.fn(async () => ({ accessToken: 'access', refreshToken: 'refresh', expiresAt: new Date(Date.now() + 300_000) })),
    refreshAccessToken: vi.fn(async () => ({ accessToken: 'access', expiresAt: new Date(Date.now() + 300_000) })),
    getAccount: vi.fn(async () => ({ googleAccountId: 'google-account', email: 'drive@example.test' })),
    listFiles: vi.fn(),
    listFolders: vi.fn(async () => ({ folders: [] })),
    getFile: vi.fn(async () => ({ id: 'uploaded-binary' })),
    createNativeFile: vi.fn(async () => ({ id: 'created-doc', name: 'Untitled document', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/created-doc' })),
    uploadBinaryFile: vi.fn(async () => ({ id: 'uploaded-binary' })),
    abortResumableUpload: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
  };
  const state = {
    create: vi.fn(() => ({ state: 'state', codeVerifier: 'verifier', cookieValue: 'cookie' })),
    codeChallenge: vi.fn(async () => 'challenge'),
    read: vi.fn(() => ({ userId, state: 'state', codeVerifier: 'verifier', expiresAt: Date.now() + 1_000 })),
  };
  const crypto = {
    encrypt: vi.fn((value: string) => `enc:${value}`),
    decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
  };
  const target = {
    resolve: vi.fn(() => ({
      type: 'DRIVE_FOLDER',
      parentFolderId: 'storage-folder',
    })),
  };
  const authorization = { assertDocumentManager: vi.fn(async () => undefined) };
  const service = new DriveService(
    { prisma } as any,
    crypto as any,
    state as any,
    provider,
    { enabled: true } as any,
    target as any,
    authorization as any,
  );
  return { service, userId, user, connection, connections, files, operations, nodes, auditLog, provider, state, crypto, prisma, target, authorization };
}

describe('DriveService', () => {
  it('binds a completed Drive OAuth connection to the authenticated user and omits tokens from its view', async () => {
    const h = harness();
    h.connections.delete('company');
    await h.service.completeAuthorization({ cookieValue: 'cookie', state: 'state', code: 'code' });
    const view = await h.service.getIntegration(h.userId);
    expect(view).toMatchObject({ connected: true, googleEmail: 'drive@example.test' });
    expect(view).not.toHaveProperty('accessTokenEncrypted');
    expect(view).not.toHaveProperty('refreshTokenEncrypted');
    expect(h.auditLog.some((entry) => entry.action === 'DRIVE_INTEGRATION_CONNECTED' && entry.actorId === h.userId)).toBe(true);
  });

  it('syncs paginated metadata idempotently, keeps same-name files distinct, and maps Workspace MIME types', async () => {
    const h = harness();
    const pages = [
      { files: [
        { id: 'doc-1', name: 'Plan', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc-1', ownedByMe: true },
        { id: 'sheet-1', name: 'Plan', mimeType: 'application/vnd.google-apps.spreadsheet', ownedByMe: true },
      ], nextPageToken: 'next' },
      { files: [
        { id: 'slide-1', name: 'Roadmap', mimeType: 'application/vnd.google-apps.presentation', ownedByMe: true },
        { id: 'pdf-1', name: 'Brief.pdf', mimeType: 'application/pdf', ownedByMe: true },
      ] },
    ];
    vi.mocked(h.provider.listFiles).mockImplementation(async () => pages.shift() ?? { files: [] });
    await h.service.sync(h.userId);
    expect(h.files.size).toBe(4);
    expect(vi.mocked(h.provider.listFiles).mock.calls[0]?.[1]).toMatchObject({
      parentFolderId: 'storage-folder',
    });
    const first = [...h.files.values()].find((file) => file.driveFileId === 'doc-1');
    expect(first.normalizedType).toBe(DriveFileType.GOOGLE_DOC);
    expect([...h.files.values()].filter((file) => file.name === 'Plan')).toHaveLength(2);
    expect(h.prisma.driveFile.upsert).toHaveBeenCalledTimes(4);

    vi.mocked(h.provider.listFiles).mockImplementation(async () => ({ files: [{ id: 'doc-1', name: 'Renamed plan', mimeType: 'application/vnd.google-apps.document', ownedByMe: true }] }));
    await h.service.sync(h.userId);
    expect(h.files.size).toBe(4);
    expect([...h.files.values()].filter((file) => file.driveFileId === 'doc-1')).toHaveLength(1);
    expect([...h.files.values()].find((file) => file.driveFileId === 'doc-1')?.name).toBe('Renamed plan');
    expect(h.auditLog.some((entry) => entry.action === 'DRIVE_SYNC_COMPLETED')).toBe(true);
  });

  it('syncs only the configured folder subtree and traverses nested folders', async () => {
    const h = harness();
    vi.mocked(h.provider.listFiles).mockImplementation(async (_token, options) => {
      if (options.parentFolderId === 'storage-folder') {
        return {
          files: [
            {
              id: 'nested-folder',
              name: 'Nested',
              mimeType: 'application/vnd.google-apps.folder',
              ownedByMe: true,
            },
            {
              id: 'root-doc',
              name: 'Root document',
              mimeType: 'application/vnd.google-apps.document',
              ownedByMe: true,
            },
          ],
        };
      }
      if (options.parentFolderId === 'nested-folder') {
        return {
          files: [
            {
              id: 'nested-doc',
              name: 'Nested document',
              mimeType: 'application/vnd.google-apps.document',
              ownedByMe: true,
            },
          ],
        };
      }
      return { files: [] };
    });
    await h.service.sync(h.userId);
    expect([...h.files.keys()]).toEqual(
      expect.arrayContaining(['nested-folder', 'root-doc', 'nested-doc']),
    );
    expect(h.provider.listFiles).toHaveBeenCalledWith(
      'access',
      expect.objectContaining({ parentFolderId: 'storage-folder' }),
    );
    expect(h.provider.listFiles).toHaveBeenCalledWith(
      'access',
      expect.objectContaining({ parentFolderId: 'nested-folder' }),
    );
  });

  it('marks a connection revoked after refresh failure and scopes file reads to the owner', async () => {
    const h = harness();
    h.connection.accessTokenExpiresAt = new Date(Date.now() - 1_000);
    vi.mocked(h.provider.refreshAccessToken).mockRejectedValue(
      new DriveProviderError('provider', 400),
    );
    await expect(h.service.sync(h.userId)).rejects.toThrow(/revoked/i);
    expect(h.connection.revokedAt).toBeInstanceOf(Date);
    await expect(h.service.listFiles(randomUUID(), {})).rejects.toThrow(/not connected/i);
  });

  it('requests Drive read access for discovery and adds drive.file for write authorization', async () => {
    const h = harness();
    await h.service.beginAuthorization(h.userId, 'READ');
    expect(vi.mocked(h.provider.authorizationUrl).mock.calls[0]?.[0].scopes).toEqual([
      GOOGLE_DRIVE_READONLY_SCOPE,
    ]);
    await h.service.beginAuthorization(h.userId, 'WRITE');
    expect(vi.mocked(h.provider.authorizationUrl).mock.calls[1]?.[0].scopes).toEqual([
      GOOGLE_DRIVE_READONLY_SCOPE,
      GOOGLE_DRIVE_FILE_SCOPE,
    ]);
  });

  it('reports read, write, and reauthorization state for a legacy connection', async () => {
    const h = harness();
    h.connection.authorizedScopes = [
      LEGACY_METADATA_READONLY_SCOPE,
      GOOGLE_DRIVE_FILE_SCOPE,
    ];
    await expect(h.service.listDriveFolders(h.userId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(h.service.listDriveFolders(h.userId)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'GOOGLE_DRIVE_READ_AUTHORIZATION_REQUIRED',
      }),
    });
    await expect(h.service.getIntegration(h.userId)).resolves.toMatchObject({
      connected: true,
      canRead: false,
      canWrite: true,
      needsReauthorization: true,
      configured: false,
    });
  });

  it('lists accessible Drive folders with the Drive read scope', async () => {
    const h = harness();
    vi.mocked(h.provider.listFolders).mockResolvedValueOnce({
      folders: [{ id: 'folder-1', name: 'Company documents', parents: [] }],
    });
    await expect(h.service.listDriveFolders(h.userId)).resolves.toEqual([
      { id: 'folder-1', name: 'Company documents', parentIds: [] },
    ]);
  });

  it('maps Drive folder discovery 403 to a safe read authorization error', async () => {
    const h = harness();
    vi.mocked(h.provider.listFolders).mockRejectedValueOnce(
      new DriveProviderError('forbidden', 403),
    );
    await expect(h.service.listDriveFolders(h.userId)).rejects.toMatchObject({
      response: {
        statusCode: 403,
        code: 'GOOGLE_DRIVE_READ_AUTHORIZATION_REQUIRED',
        message: 'Google Drive read authorization is required.',
      },
    });
    expect(h.provider.listFolders).toHaveBeenCalledWith(
      'access',
      undefined,
      undefined,
    );
  });

  it('validates and persists an arbitrary Drive folder as the storage target', async () => {
    const h = harness();
    vi.mocked(h.provider.getFile).mockResolvedValueOnce({
      id: 'folder-2',
      name: 'Docs Hub storage',
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canAddChildren: true },
    });
    await expect(
      h.service.configureStorageFolder(h.userId, 'folder-2'),
    ).resolves.toMatchObject({ configured: true });
    expect(h.connection).toMatchObject({
      sharedDriveId: null,
      sharedDriveName: null,
      storageFolderId: 'folder-2',
      storageFolderName: 'Docs Hub storage',
    });
    expect(h.auditLog.some((entry) => entry.action === 'DRIVE_STORAGE_FOLDER_CONFIGURED')).toBe(true);
  });

  it('rejects a non-folder storage target', async () => {
    const h = harness();
    vi.mocked(h.provider.getFile).mockResolvedValueOnce({
      id: 'file-2',
      mimeType: 'application/pdf',
    });
    await expect(
      h.service.configureStorageFolder(h.userId, 'file-2'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a storage folder that explicitly denies child creation', async () => {
    const h = harness();
    vi.mocked(h.provider.getFile).mockResolvedValueOnce({
      id: 'read-only-folder',
      name: 'Read only',
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canAddChildren: false },
    });
    await expect(
      h.service.configureStorageFolder(h.userId, 'read-only-folder'),
    ).rejects.toMatchObject({
      response: {
        code: 'GOOGLE_DRIVE_STORAGE_FOLDER_NOT_WRITABLE',
      },
    });
  });

  it('allows only an active administrator to start the company integration flow', async () => {
    const h = harness();
    h.user.systemRole = 'VIEWER';
    await expect(h.service.beginAuthorization(h.userId, 'WRITE')).rejects.toThrow(
      /administrator/i,
    );
  });

  it('creates a native document with localized naming, Drive metadata, a logical node, and an audit event', async () => {
    const h = harness();
    const result = await h.service.createNativeDocument(
      h.userId,
      { kind: 'DOCUMENT', locale: 'vi', parentId: null } as any,
      'create-document-1',
    );
    expect(result).toMatchObject({
      kind: 'DOCUMENT',
      name: 'Tài liệu chưa đặt tên',
      driveFileId: 'created-doc',
    });
    expect(h.provider.createNativeFile).toHaveBeenCalledWith('access', {
      name: 'Tài liệu chưa đặt tên',
      mimeType: 'application/vnd.google-apps.document',
      parentFolderId: 'storage-folder',
    });
    expect(h.operations.get('create-document-1')).toMatchObject({
      status: DriveCreationOperationStatus.SUCCEEDED,
      driveFileId: 'created-doc',
    });
    expect(h.auditLog.some((entry) => entry.action === 'GOOGLE_DRIVE_DOCUMENT_CREATED')).toBe(true);
  });

  it('creates each native Workspace kind with its corresponding MIME type', async () => {
    const h = harness();
    await h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'document-key');
    await h.service.createNativeDocument(h.userId, { kind: 'SPREADSHEET' } as any, 'spreadsheet-key');
    await h.service.createNativeDocument(h.userId, { kind: 'PRESENTATION' } as any, 'presentation-key');
    expect(vi.mocked(h.provider.createNativeFile).mock.calls.map((call) => call[1].mimeType)).toEqual([
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ]);
  });

  it('keeps the logical parent separate from the configured physical Drive parent', async () => {
    const h = harness();
    const logicalParentId = randomUUID();
    h.target.resolve.mockReturnValue({ type: 'DRIVE_FOLDER', parentFolderId: 'physical-target' });
    h.prisma.node.findFirst.mockImplementation(async (args: any) =>
      args.where.type === 'FOLDER' ? { id: logicalParentId } : null,
    );
    const result = await h.service.createNativeDocument(
      h.userId,
      { kind: 'SPREADSHEET', parentId: logicalParentId } as any,
      'nested-key',
    );
    expect(result.parentId).toBe(logicalParentId);
    expect(h.provider.createNativeFile).toHaveBeenCalledWith('access', expect.objectContaining({
      parentFolderId: 'physical-target',
    }));
  });

  it('replays a successful idempotency key without creating another Drive file', async () => {
    const h = harness();
    const first = await h.service.createNativeDocument(h.userId, { kind: 'SPREADSHEET' } as any, 'same-key');
    const second = await h.service.createNativeDocument(h.userId, { kind: 'SPREADSHEET' } as any, 'same-key');
    expect(second).toEqual(first);
    expect(h.provider.createNativeFile).toHaveBeenCalledTimes(1);
  });

  it('lets the next metadata sync update the existing DriveFile instead of duplicating it', async () => {
    const h = harness();
    await h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'sync-key');
    vi.mocked(h.provider.listFiles).mockResolvedValueOnce({
      files: [{
        id: 'created-doc',
        name: 'Renamed in Google Docs',
        mimeType: 'application/vnd.google-apps.document',
        ownedByMe: true,
      }],
    });
    await h.service.sync(h.userId);
    expect(h.files.size).toBe(1);
    expect([...h.files.values()][0]).toMatchObject({
      driveFileId: 'created-doc',
      name: 'Renamed in Google Docs',
    });
  });

  it('compensates a remote file when transactional Docs Hub registration fails', async () => {
    const h = harness();
    vi.mocked(h.prisma.node.create).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(
      h.service.createNativeDocument(h.userId, { kind: 'PRESENTATION' } as any, 'compensate-key'),
    ).rejects.toThrow(/removed/i);
    expect(h.provider.deleteFile).toHaveBeenCalledWith('access', 'created-doc');
    expect(h.operations.get('compensate-key')).toMatchObject({ status: DriveCreationOperationStatus.FAILED });
  });

  it('records an orphan audit when remote compensation fails', async () => {
    const h = harness();
    vi.mocked(h.prisma.node.create).mockRejectedValueOnce(new Error('database unavailable'));
    vi.mocked(h.provider.deleteFile).mockRejectedValueOnce(new Error('delete denied'));
    await expect(
      h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'orphan-key'),
    ).rejects.toThrow(/Reconcile Drive file/i);
    expect(h.auditLog).toContainEqual(expect.objectContaining({
      action: 'GOOGLE_DRIVE_DOCUMENT_ORPHANED',
      resourceId: null,
    }));
  });

  it('does not create a Docs Hub node when Google rejects the native create request', async () => {
    const h = harness();
    vi.mocked(h.provider.createNativeFile).mockRejectedValueOnce(new DriveProviderError('forbidden', 403));
    await expect(
      h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'provider-failure-key'),
    ).rejects.toThrow();
    expect(h.prisma.node.create).not.toHaveBeenCalled();
    expect(h.operations.get('provider-failure-key')).toMatchObject({ status: DriveCreationOperationStatus.FAILED });
  });

  it('rejects native creation for a read-only Drive connection', async () => {
    const h = harness();
    h.connection.authorizedScopes = [GOOGLE_DRIVE_READONLY_SCOPE];
    await expect(
      h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'read-only-key'),
    ).rejects.toThrow(/write access/i);
    expect(h.provider.createNativeFile).not.toHaveBeenCalled();
  });

  it('denies native creation when the account-level document-manager gate rejects the actor', async () => {
    const h = harness();
    vi.mocked(h.authorization.assertDocumentManager).mockRejectedValueOnce(new Error('denied'));
    await expect(
      h.service.createNativeDocument(h.userId, { kind: 'DOCUMENT' } as any, 'role-denied-key'),
    ).rejects.toThrow('denied');
    expect(h.provider.createNativeFile).not.toHaveBeenCalled();
  });
});
