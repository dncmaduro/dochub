import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentRole,
  FileProcessingTaskType,
  FileVersionSource,
  GeneralAccessRole,
  NodeType,
  prisma,
  TrashOperationStatus,
  UserStatus,
} from '@dochub/database';
import { LocalFileStorage, type StorageService } from '@dochub/storage';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import type { FileValidationService } from './file-validation.service.js';
import { FilesService } from './files.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;

withDatabase('FilesService version history integration', () => {
  const suffix = randomUUID();
  const ownerId = randomUUID();
  const viewerId = randomUUID();
  const editorId = randomUUID();
  const outsiderId = randomUUID();
  const nodeId = randomUUID();
  const fileId = randomUUID();
  const versionIds: string[] = [];
  const storageRoot = `/tmp/dochub-version-history-${suffix}`;
  const storage = new LocalFileStorage(storageRoot);
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const files = new FilesService(
    database,
    authorization,
    {} as FileValidationService,
    storage,
  );
  let uploadId: string;
  let editorVersionId: string;
  let systemVersionId: string;

  async function storedVersion(input: {
    versionNumber: number;
    source: FileVersionSource;
    sourceVersionId?: string;
    bytes: Buffer;
  }): Promise<string> {
    const id = randomUUID();
    const storageKey = `files/${fileId}/versions/${id}`;
    await storage.putStream(storageKey, Readable.from(input.bytes));
    await prisma.fileVersion.create({
      data: {
        id,
        fileId,
        versionNumber: input.versionNumber,
        storageKey,
        originalFilename: 'history.pdf',
        mimeType: 'application/pdf',
        extension: 'pdf',
        sizeBytes: BigInt(input.bytes.length),
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        source: input.source,
        sourceVersionId: input.sourceVersionId,
        createdById: ownerId,
      },
    });
    versionIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          email: `versions-owner-${suffix}@example.test`,
          normalizedEmail: `versions-owner-${suffix}@example.test`,
          displayName: 'Version owner',
          status: UserStatus.ACTIVE,
        },
        {
          id: viewerId,
          email: `versions-viewer-${suffix}@example.test`,
          normalizedEmail: `versions-viewer-${suffix}@example.test`,
          displayName: 'Version viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: editorId,
          email: `versions-editor-${suffix}@example.test`,
          normalizedEmail: `versions-editor-${suffix}@example.test`,
          displayName: 'Version editor',
          status: UserStatus.ACTIVE,
        },
        {
          id: outsiderId,
          email: `versions-outsider-${suffix}@example.test`,
          normalizedEmail: `versions-outsider-${suffix}@example.test`,
          displayName: 'Version outsider',
          status: UserStatus.ACTIVE,
        },
      ],
    });
    await prisma.node.create({
      data: {
        id: nodeId,
        type: NodeType.FILE,
        name: `history-${suffix}.pdf`,
        normalizedName: `history-${suffix}`,
        generalAccessRole: GeneralAccessRole.RESTRICTED,
        createdById: ownerId,
      },
    });
    await prisma.permissionEntry.createMany({
      data: [
        { nodeId, userId: ownerId, role: DocumentRole.OWNER },
        { nodeId, userId: viewerId, role: DocumentRole.VIEWER },
        { nodeId, userId: editorId, role: DocumentRole.EDITOR },
      ],
    });
    await prisma.file.create({ data: { id: fileId, nodeId } });
    uploadId = await storedVersion({
      versionNumber: 1,
      source: FileVersionSource.UPLOAD,
      bytes: Buffer.from('version one'),
    });
    editorVersionId = await storedVersion({
      versionNumber: 2,
      source: FileVersionSource.EDITOR,
      sourceVersionId: uploadId,
      bytes: Buffer.from('version two'),
    });
    systemVersionId = await storedVersion({
      versionNumber: 3,
      source: FileVersionSource.SYSTEM,
      bytes: Buffer.from('version three'),
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { versionCounter: 3, currentVersionId: systemVersionId },
    });
  });

  afterAll(async () => {
    const keys = await prisma.fileVersion.findMany({
      where: { fileId },
      select: { storageKey: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ resourceId: nodeId }, { resourceId: { in: versionIds } }],
      },
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: null },
    });
    await prisma.fileVersion.deleteMany({ where: { fileId } });
    await prisma.file.delete({ where: { id: fileId } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId } });
    await prisma.node.delete({ where: { id: nodeId } });
    await prisma.user.deleteMany({
      where: { id: { in: [ownerId, viewerId, editorId, outsiderId] } },
    });
    await Promise.all(keys.map(({ storageKey }) => storage.delete(storageKey)));
    await rm(storageRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('lists immutable versions newest first without mutating their metadata', async () => {
    const before = await prisma.fileVersion.findMany({
      where: { fileId },
      select: {
        id: true,
        source: true,
        sourceVersionId: true,
        storageKey: true,
      },
      orderBy: { versionNumber: 'asc' },
    });
    const listed = await files.listVersions(viewerId, nodeId);
    expect(listed.nodeId).toBe(nodeId);
    expect(listed.items.map((version) => version.id)).toEqual([
      systemVersionId,
      editorVersionId,
      uploadId,
    ]);
    expect(listed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: uploadId,
          source: FileVersionSource.UPLOAD,
          sourceVersionId: null,
          isCurrent: false,
        }),
        expect.objectContaining({
          id: editorVersionId,
          source: FileVersionSource.EDITOR,
          sourceVersionId: uploadId,
          isCurrent: false,
        }),
        expect.objectContaining({
          id: systemVersionId,
          source: FileVersionSource.SYSTEM,
          isCurrent: true,
        }),
      ]),
    );
    await expect(files.listVersions(outsiderId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      files.restoreVersion(viewerId, nodeId, uploadId),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      prisma.fileVersion.findMany({
        where: { fileId },
        select: {
          id: true,
          source: true,
          sourceVersionId: true,
          storageKey: true,
        },
        orderBy: { versionNumber: 'asc' },
      }),
    ).resolves.toEqual(before);
  });

  it('restores a historical version as a new immutable version with storage, task, and audit records', async () => {
    const source = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: uploadId },
    });
    const sourceBytes = await streamBytes(
      await storage.openReadStream(source.storageKey),
    );
    const restored = await files.restoreVersion(editorId, nodeId, uploadId);
    versionIds.push(restored.version.id);
    expect(restored.version.versionNumber).toBe(4);
    const current = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    const restoredRow = await prisma.fileVersion.findUniqueOrThrow({
      where: { id: restored.version.id },
    });
    expect(current).toMatchObject({
      versionCounter: 4,
      currentVersionId: restoredRow.id,
    });
    expect(restoredRow).toMatchObject({
      versionNumber: 4,
      source: FileVersionSource.RESTORE,
      sourceVersionId: uploadId,
      createdById: editorId,
    });
    expect(restoredRow.storageKey).not.toBe(source.storageKey);
    expect(
      await streamBytes(await storage.openReadStream(restoredRow.storageKey)),
    ).toEqual(sourceBytes);
    expect(
      await streamBytes(await storage.openReadStream(source.storageKey)),
    ).toEqual(sourceBytes);
    await expect(
      prisma.fileProcessingTask.findUnique({
        where: {
          fileVersionId_type: {
            fileVersionId: restoredRow.id,
            type: FileProcessingTaskType.TEXT_EXTRACTION,
          },
        },
      }),
    ).resolves.toBeTruthy();
    await expect(
      prisma.auditLog.findFirst({
        where: { resourceId: restoredRow.id, action: 'FILE_VERSION_RESTORED' },
      }),
    ).resolves.toMatchObject({ actorId: editorId, actorType: 'USER' });
  });

  it('serializes concurrent restores into coherent successive immutable versions', async () => {
    const results = await Promise.all([
      files.restoreVersion(editorId, nodeId, uploadId),
      files.restoreVersion(editorId, nodeId, editorVersionId),
    ]);
    versionIds.push(...results.map((result) => result.version.id));
    const current = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    const versions = await prisma.fileVersion.findMany({
      where: { fileId },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions).toHaveLength(current.versionCounter);
    expect(versions.at(-1)?.id).toBe(current.currentVersionId);
    expect(new Set(versions.map((version) => version.versionNumber)).size).toBe(
      versions.length,
    );
    expect(
      versions
        .slice(-2)
        .every((version) => version.source === FileVersionSource.RESTORE),
    ).toBe(true);
  });

  it('removes a newly copied object when the version transaction fails', async () => {
    let copiedKey: string | undefined;
    const failingStorage: StorageService = {
      putStream: async (storageKey, readable) => {
        copiedKey = storageKey;
        await storage.putStream(storageKey, readable);
      },
      promote: storage.promote.bind(storage),
      openReadStream: storage.openReadStream.bind(storage),
      stat: storage.stat.bind(storage),
      exists: storage.exists.bind(storage),
      delete: storage.delete.bind(storage),
    };
    const failingPrisma = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return async () => {
            throw new Error('forced transaction failure');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const failingDatabase = {
      prisma: failingPrisma,
    } as unknown as DatabaseService;
    const failingFiles = new FilesService(
      failingDatabase,
      new DocumentAuthorizationService(failingDatabase),
      {} as FileValidationService,
      failingStorage,
    );
    const before = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    await expect(
      failingFiles.restoreVersion(editorId, nodeId, uploadId),
    ).rejects.toThrow('forced transaction failure');
    expect(copiedKey).toBeDefined();
    await expect(storage.exists(copiedKey!)).resolves.toBe(false);
    await expect(
      prisma.file.findUnique({ where: { id: fileId } }),
    ).resolves.toEqual(before);
  });

  it('hides version history for a trashed file', async () => {
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: nodeId,
        trashedById: ownerId,
        status: TrashOperationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: operation.id },
    });
    await expect(files.listVersions(viewerId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
  });
});

async function streamBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
