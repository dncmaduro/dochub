import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { DocumentRole, NodeType, prisma, UserStatus } from '@dochub/database';
import { LocalFileStorage, type StorageService } from '@dochub/storage';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { FilesService } from '../files/files.service.js';
import type { FileValidationService } from '../files/file-validation.service.js';
import type { EditorConfig } from './editor.config.js';
import { EditorSessionService } from './editor-session.service.js';

const withDb = process.env.DATABASE_URL ? describe : describe.skip;
withDb('EditorSessionService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const outsiderId = randomUUID();
  const nodeId = randomUUID();
  const fileId = randomUUID();
  const versionIds: string[] = [];
  const config: EditorConfig = {
    publicUrl: new URL('http://localhost:8082'),
    internalApiUrl: new URL('http://host.docker.internal:3000'),
    jwtSecret: 'a'.repeat(32),
    fetchTokenSecret: 'b'.repeat(32),
    fetchTokenTtlSeconds: 900,
    callbackTokenTtlSeconds: 3600,
    editCloseGraceSeconds: 60,
  };
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const objectStorage = new LocalFileStorage('/tmp/dochub-editor-storage');
  const permanentKeys: string[] = [];
  const service = new EditorSessionService(
    database,
    authorization,
    new JwtService(),
    config,
    {
      uploadTempRoot: '/tmp/dochub-editor-test',
      uploadMaxBytes: 1024 * 1024,
      root: '/tmp/dochub-editor-storage',
      driver: 'local',
    },
    objectStorage,
  );
  const files = new FilesService(
    database,
    authorization,
    {
      validate: async (upload) => ({
        originalFilename: upload.originalFilename,
        nodeName: upload.originalFilename.replace(/\.docx$/, ''),
        normalizedNodeName: upload.originalFilename.replace(/\.docx$/, ''),
        extension: 'docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: upload.sizeBytes,
        sha256: upload.sha256,
      }),
    } as FileValidationService,
    objectStorage,
  );

  async function version(number: number) {
    const id = randomUUID();
    versionIds.push(id);
    await prisma.fileVersion.create({
      data: {
        id,
        fileId,
        versionNumber: number,
        storageKey: `editor/${id}`,
        originalFilename: `brief-${number}.docx`,
        extension: 'docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: 4n,
        sha256: id.replaceAll('-', '').padEnd(64, '0'),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: id, versionCounter: number },
    });
    return id;
  }

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `editor-${suffix}@test`,
          normalizedEmail: `editor-${suffix}@test`,
          displayName: 'Editor Viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: outsiderId,
          email: `editor-out-${suffix}@test`,
          normalizedEmail: `editor-out-${suffix}@test`,
          displayName: 'No Access',
          status: UserStatus.ACTIVE,
        },
      ],
    });
    await prisma.node.create({
      data: {
        id: nodeId,
        type: NodeType.FILE,
        name: `brief-${suffix}.docx`,
        normalizedName: `brief-${suffix}`,
        createdById: actorId,
      },
    });
    await prisma.permissionEntry.create({
      data: { nodeId, userId: actorId, role: DocumentRole.VIEWER },
    });
    await prisma.file.create({ data: { id: fileId, nodeId } });
    await version(1);
  });
  afterAll(async () => {
    await prisma.editorSession.deleteMany({ where: { fileId } });
    await prisma.file.update({
      where: { id: fileId },
      data: { currentVersionId: null },
    });
    await prisma.fileVersion.deleteMany({ where: { id: { in: versionIds } } });
    await prisma.file.delete({ where: { id: fileId } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId } });
    await prisma.node.delete({ where: { id: nodeId } });
    await prisma.user.deleteMany({
      where: { id: { in: [actorId, outsiderId] } },
    });
    await Promise.all(permanentKeys.map((key) => objectStorage.delete(key)));
    await rm('/tmp/dochub-editor-test/editor', {
      recursive: true,
      force: true,
    });
    await prisma.$disconnect();
  });

  it('creates an immutable VIEW snapshot with signed, non-secret config', async () => {
    const created = await service.create(actorId, nodeId);
    expect(created.session).toMatchObject({
      mode: 'VIEW',
      status: 'ACTIVE',
      expiresAt: null,
    });
    expect(created.config).toMatchObject({
      documentType: 'word',
      document: {
        fileType: 'docx',
        permissions: { edit: false, download: true, print: true },
      },
      editorConfig: { mode: 'view', user: { id: actorId } },
    });
    expect(JSON.stringify(created)).not.toContain(config.jwtSecret);
    expect(JSON.stringify(created)).not.toContain(config.fetchTokenSecret);
    const signedConfig = await new JwtService().verifyAsync(
      created.config.token,
      {
        secret: config.jwtSecret,
        algorithms: ['HS256'],
      },
    );
    expect(signedConfig).toMatchObject({
      documentType: 'word',
      editorConfig: { mode: 'view' },
    });
    await expect(
      new JwtService().verifyAsync(`${created.config.token}x`, {
        secret: config.jwtSecret,
      }),
    ).rejects.toBeTruthy();
    const persisted = await prisma.editorSession.findUniqueOrThrow({
      where: { id: created.session.id },
    });
    expect(persisted.baseVersionId).toBe(versionIds[0]);
    expect(persisted.documentKey).toBe(
      EditorSessionService.documentKey(versionIds[0], created.session.id),
    );
    await expect(service.create(outsiderId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('creates EDIT only for EDIT-capable users and emits a callback capability', async () => {
    await expect(service.create(actorId, nodeId, 'EDIT')).rejects.toMatchObject(
      { status: 403 },
    );
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    expect(created.session).toMatchObject({ mode: 'EDIT', status: 'ACTIVE' });
    expect(created.config).toMatchObject({
      document: { permissions: { edit: true } },
      editorConfig: { mode: 'edit' },
    });
    const callback = new URL(
      (created.config.editorConfig as { callbackUrl: string }).callbackUrl,
    );
    expect(callback.origin).toBe(config.internalApiUrl.origin);
    const capability = callback.searchParams.get('capability');
    expect(capability).toBeTruthy();
    await expect(
      new JwtService().verifyAsync(capability!, {
        secret: config.fetchTokenSecret,
        audience: 'onlyoffice-callback',
      }),
    ).resolves.toMatchObject({
      sessionId: created.session.id,
      baseVersionId: versionIds.at(-1),
      purpose: 'onlyoffice-callback',
    });
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.VIEWER },
    });
  });

  it('keeps an EDIT session active after an authenticated status 4 so a retried save remains eligible', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const callback = new URL(
      (created.config.editorConfig as { callbackUrl: string }).callbackUrl,
    );
    const signed = new JwtService().sign(
      { status: 4, key: created.config.document.key },
      { secret: config.jwtSecret, algorithm: 'HS256' },
    );
    await expect(
      service.handleCallback(
        created.session.id,
        callback.searchParams.get('capability')!,
        { status: 4, key: created.config.document.key, token: signed },
      ),
    ).resolves.toEqual({ error: 0 });
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({ status: 'ACTIVE', stagedArtifactId: null });
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.VIEWER },
    });
  });

  it('closes a gracefully requested unchanged EDIT session on status 4 without creating a version', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const before = await prisma.fileVersion.count({ where: { fileId } });
    const closedAt = new Date();
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: { closedAt },
    });
    const callback = new URL(
      (created.config.editorConfig as { callbackUrl: string }).callbackUrl,
    );
    const signed = new JwtService().sign(
      { status: 4, key: created.config.document.key },
      { secret: config.jwtSecret, algorithm: 'HS256' },
    );
    await expect(
      service.handleCallback(
        created.session.id,
        callback.searchParams.get('capability')!,
        { status: 4, key: created.config.document.key, token: signed },
      ),
    ).resolves.toEqual({ error: 0 });
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({
      status: 'CLOSED',
      finalizedFileVersionId: null,
      closedAt,
    });
    await expect(prisma.fileVersion.count({ where: { fileId } })).resolves.toBe(
      before,
    );
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.VIEWER },
    });
  });

  it('keeps old sessions on V1 and makes a new key for V2', async () => {
    const first = await service.create(actorId, nodeId);
    const v2 = await version(2);
    const second = await service.create(actorId, nodeId);
    expect(first.config.document.key).not.toBe(second.config.document.key);
    const firstRow = await prisma.editorSession.findUniqueOrThrow({
      where: { id: first.session.id },
    });
    const secondRow = await prisma.editorSession.findUniqueOrThrow({
      where: { id: second.session.id },
    });
    expect(firstRow.baseVersionId).toBe(versionIds[0]);
    expect(secondRow.baseVersionId).toBe(v2);
  });

  it('reopens an unchanged VIEW version with an isolated ONLYOFFICE source identity', async () => {
    const before = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
      select: { currentVersionId: true, versionCounter: true },
    });
    const versionsBefore = await prisma.fileVersion.count({
      where: { fileId },
    });
    const first = await service.create(actorId, nodeId);
    const firstSource = new URL(first.config.document.url);
    const firstToken = firstSource.searchParams.get('token')!;

    await expect(
      service.close(actorId, first.session.id),
    ).resolves.toMatchObject({
      id: first.session.id,
      status: 'CLOSED',
      closedAt: expect.any(Date),
    });
    const second = await service.create(actorId, nodeId);
    const secondSource = new URL(second.config.document.url);
    const secondToken = secondSource.searchParams.get('token')!;

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.config.document.key).not.toBe(first.config.document.key);
    expect(secondSource.pathname).toContain(second.session.id);
    expect(secondSource.pathname).not.toContain(first.session.id);
    await expect(
      service.authorizeFetch(first.session.id, firstToken),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.authorizeFetch(second.session.id, secondToken),
    ).resolves.toMatchObject({
      nodeId,
      versionId: before.currentVersionId,
    });
    await expect(
      prisma.editorSession.findMany({
        where: { id: { in: [first.session.id, second.session.id] } },
        select: { id: true, status: true, closedAt: true, baseVersionId: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.session.id,
          status: 'CLOSED',
          closedAt: expect.any(Date),
          baseVersionId: before.currentVersionId,
        }),
        expect.objectContaining({
          id: second.session.id,
          status: 'ACTIVE',
          closedAt: null,
          baseVersionId: before.currentVersionId,
        }),
      ]),
    );
    await expect(
      prisma.file.findUniqueOrThrow({
        where: { id: fileId },
        select: { currentVersionId: true, versionCounter: true },
      }),
    ).resolves.toEqual(before);
    await expect(prisma.fileVersion.count({ where: { fileId } })).resolves.toBe(
      versionsBefore,
    );
    await expect(
      service.close(actorId, second.session.id),
    ).resolves.toMatchObject({
      id: second.session.id,
      status: 'CLOSED',
      closedAt: expect.any(Date),
    });
  });

  it('finalizes staged EDIT bytes as one immutable editor version', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const baseVersionId = (
      await prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
        select: { baseVersionId: true },
      })
    ).baseVersionId;
    const artifactId = randomUUID();
    const bytes = Buffer.from('after edit');
    const stagedPath = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      created.session.id,
      artifactId,
    );
    await mkdir(path.dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: {
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(bytes.length),
        stagedSha256: digest,
        stagedAt: new Date(),
      },
    });
    const finalizer = service as unknown as {
      finalizeStagedDocument(id: string): Promise<void>;
    };
    await Promise.all([
      finalizer.finalizeStagedDocument(created.session.id),
      finalizer.finalizeStagedDocument(created.session.id),
    ]);
    const finalized = await prisma.editorSession.findUniqueOrThrow({
      where: { id: created.session.id },
      include: { finalizedFileVersion: true, file: true },
    });
    expect(finalized.status).toBe('CLOSED');
    expect(finalized.finalizedFileVersion).toMatchObject({
      source: 'EDITOR',
      sourceVersionId: baseVersionId,
      sha256: digest,
    });
    expect(finalized.file.currentVersionId).toBe(
      finalized.finalizedFileVersionId,
    );
    expect(finalized.file.versionCounter).toBe(
      finalized.finalizedFileVersion!.versionNumber,
    );
    expect(
      await objectStorage.exists(finalized.finalizedFileVersion!.storageKey),
    ).toBe(true);
    await expect(
      prisma.fileProcessingTask.findMany({
        where: { fileVersionId: finalized.finalizedFileVersionId! },
      }),
    ).resolves.toHaveLength(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { resourceId: finalized.finalizedFileVersionId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toMatchObject({
      actorType: 'USER',
      actorId,
      action: 'FILE_VERSION_CREATED',
      resourceType: 'FILE_VERSION',
      result: 'SUCCESS',
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(
      /after edit|editor\/|token|jwt|http/i,
    );
    permanentKeys.push(finalized.finalizedFileVersion!.storageKey);
    versionIds.push(finalized.finalizedFileVersionId!);
    await expect(
      finalizer.finalizeStagedDocument(created.session.id),
    ).resolves.toBeUndefined();
    expect(await prisma.fileVersion.count({ where: { fileId } })).toBe(
      finalized.file.versionCounter,
    );
  });

  it.each(['missing', 'sha-mismatch', 'size-mismatch'] as const)(
    'rejects a %s staged artifact without advancing the file',
    async (failure) => {
      await prisma.permissionEntry.updateMany({
        where: { nodeId, userId: actorId },
        data: { role: DocumentRole.EDITOR },
      });
      const created = await service.create(actorId, nodeId, 'EDIT');
      const artifactId = randomUUID();
      const bytes = Buffer.from('staged validation failure');
      const pathname = path.join(
        '/tmp/dochub-editor-test',
        'editor',
        created.session.id,
        artifactId,
      );
      if (failure !== 'missing') {
        await mkdir(path.dirname(pathname), { recursive: true });
        await writeFile(pathname, bytes);
      }
      await prisma.editorSession.update({
        where: { id: created.session.id },
        data: {
          stagedArtifactId: artifactId,
          stagedSha256:
            failure === 'sha-mismatch'
              ? '0'.repeat(64)
              : createHash('sha256').update(bytes).digest('hex'),
          stagedSizeBytes:
            failure === 'size-mismatch'
              ? BigInt(bytes.length + 1)
              : BigInt(bytes.length),
          stagedAt: new Date(),
        },
      });
      const before = await prisma.file.findUniqueOrThrow({
        where: { id: fileId },
      });
      const count = await prisma.fileVersion.count({ where: { fileId } });
      const finalizer = service as unknown as {
        finalizeStagedDocument(id: string): Promise<void>;
      };
      await expect(
        finalizer.finalizeStagedDocument(created.session.id),
      ).rejects.toBeTruthy();
      await expect(
        prisma.file.findUniqueOrThrow({ where: { id: fileId } }),
      ).resolves.toMatchObject(before);
      await expect(
        prisma.fileVersion.count({ where: { fileId } }),
      ).resolves.toBe(count);
    },
  );

  it('preserves staged bytes when permanent editor storage write fails', async () => {
    const created = await service.create(actorId, nodeId, 'EDIT');
    const artifactId = randomUUID();
    const bytes = Buffer.from('retryable storage failure');
    const pathname = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      created.session.id,
      artifactId,
    );
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, bytes);
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: {
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(bytes.length),
        stagedSha256: createHash('sha256').update(bytes).digest('hex'),
        stagedAt: new Date(),
      },
    });
    const failingStorage: StorageService = {
      putStream: async () => {
        throw new Error('storage unavailable');
      },
      openReadStream: objectStorage.openReadStream.bind(objectStorage),
      stat: objectStorage.stat.bind(objectStorage),
      exists: objectStorage.exists.bind(objectStorage),
      delete: objectStorage.delete.bind(objectStorage),
    };
    const failingService = new EditorSessionService(
      database,
      authorization,
      new JwtService(),
      config,
      {
        uploadTempRoot: '/tmp/dochub-editor-test',
        uploadMaxBytes: 1024 * 1024,
        root: '/tmp/dochub-editor-storage',
        driver: 'local',
      },
      failingStorage,
    );
    const before = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    await expect(
      (
        failingService as unknown as {
          finalizeStagedDocument(id: string): Promise<void>;
        }
      ).finalizeStagedDocument(created.session.id),
    ).rejects.toBeTruthy();
    await expect(
      prisma.file.findUniqueOrThrow({ where: { id: fileId } }),
    ).resolves.toMatchObject(before);
    await expect(stat(pathname)).resolves.toBeDefined();
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({
      finalizedFileVersionId: null,
      stagedArtifactId: artifactId,
    });
  });

  it('removes the permanent orphan and preserves staging when database finalization fails', async () => {
    const created = await service.create(actorId, nodeId, 'EDIT');
    const artifactId = randomUUID();
    const bytes = Buffer.from('database compensation retry');
    const pathname = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      created.session.id,
      artifactId,
    );
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, bytes);
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: {
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(bytes.length),
        stagedSha256: createHash('sha256').update(bytes).digest('hex'),
        stagedAt: new Date(),
      },
    });
    let writtenKey: string | undefined;
    const recordingStorage: StorageService = {
      putStream: async (key, stream) => {
        writtenKey = key;
        await objectStorage.putStream(key, stream);
      },
      openReadStream: objectStorage.openReadStream.bind(objectStorage),
      stat: objectStorage.stat.bind(objectStorage),
      exists: objectStorage.exists.bind(objectStorage),
      delete: objectStorage.delete.bind(objectStorage),
    };
    const failingDatabase = {
      prisma: new Proxy(prisma, {
        get(target, property, receiver) {
          if (property === '$transaction')
            return async () => {
              throw new Error('transaction unavailable');
            };
          return Reflect.get(target, property, receiver);
        },
      }),
    } as unknown as DatabaseService;
    const failingService = new EditorSessionService(
      failingDatabase,
      authorization,
      new JwtService(),
      config,
      {
        uploadTempRoot: '/tmp/dochub-editor-test',
        uploadMaxBytes: 1024 * 1024,
        root: '/tmp/dochub-editor-storage',
        driver: 'local',
      },
      recordingStorage,
    );
    const before = await prisma.file.findUniqueOrThrow({
      where: { id: fileId },
    });
    await expect(
      (
        failingService as unknown as {
          finalizeStagedDocument(id: string): Promise<void>;
        }
      ).finalizeStagedDocument(created.session.id),
    ).rejects.toBeTruthy();
    expect(writtenKey).toBeTruthy();
    await expect(objectStorage.exists(writtenKey!)).resolves.toBe(false);
    await expect(stat(pathname)).resolves.toBeDefined();
    await expect(
      prisma.file.findUniqueOrThrow({ where: { id: fileId } }),
    ).resolves.toMatchObject(before);
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({
      finalizedFileVersionId: null,
      finalizedAt: null,
      stagedArtifactId: artifactId,
    });
  });

  it.each(['edit-revoked', 'actor-suspended', 'node-trashed'] as const)(
    'preserves staged bytes when finalization is blocked by %s',
    async (blocker) => {
      await prisma.permissionEntry.updateMany({
        where: { nodeId, userId: actorId },
        data: { role: DocumentRole.EDITOR },
      });
      await prisma.user.update({
        where: { id: actorId },
        data: { status: UserStatus.ACTIVE },
      });
      const created = await service.create(actorId, nodeId, 'EDIT');
      const artifactId = randomUUID();
      const bytes = Buffer.from(`blocked finalization ${blocker}`);
      const pathname = path.join(
        '/tmp/dochub-editor-test',
        'editor',
        created.session.id,
        artifactId,
      );
      await mkdir(path.dirname(pathname), { recursive: true });
      await writeFile(pathname, bytes);
      await prisma.editorSession.update({
        where: { id: created.session.id },
        data: {
          stagedArtifactId: artifactId,
          stagedSizeBytes: BigInt(bytes.length),
          stagedSha256: createHash('sha256').update(bytes).digest('hex'),
          stagedAt: new Date(),
        },
      });
      let operationId: string | undefined;
      if (blocker === 'edit-revoked') {
        await prisma.permissionEntry.updateMany({
          where: { nodeId, userId: actorId },
          data: { role: DocumentRole.VIEWER },
        });
      } else if (blocker === 'actor-suspended') {
        await prisma.user.update({
          where: { id: actorId },
          data: { status: UserStatus.SUSPENDED },
        });
      } else {
        operationId = randomUUID();
        await prisma.trashOperation.create({
          data: {
            id: operationId,
            rootNodeId: nodeId,
            trashedById: actorId,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        await prisma.node.update({
          where: { id: nodeId },
          data: { trashOperationId: operationId },
        });
      }
      const before = await prisma.file.findUniqueOrThrow({
        where: { id: fileId },
      });
      const finalizer = service as unknown as {
        finalizeStagedDocument(id: string): Promise<void>;
      };
      await expect(
        finalizer.finalizeStagedDocument(created.session.id),
      ).rejects.toBeTruthy();
      await expect(
        prisma.file.findUniqueOrThrow({ where: { id: fileId } }),
      ).resolves.toMatchObject(before);
      await expect(stat(pathname)).resolves.toBeDefined();
      await expect(
        prisma.editorSession.findUniqueOrThrow({
          where: { id: created.session.id },
        }),
      ).resolves.toMatchObject({
        finalizedFileVersionId: null,
        finalizedAt: null,
        stagedArtifactId: artifactId,
      });
      if (operationId) {
        await expect(
          prisma.node.findUniqueOrThrow({ where: { id: nodeId } }),
        ).resolves.toMatchObject({ trashOperationId: operationId });
        await prisma.node.update({
          where: { id: nodeId },
          data: { trashOperationId: null },
        });
        await prisma.trashOperation.delete({ where: { id: operationId } });
      }
      await prisma.user.update({
        where: { id: actorId },
        data: { status: UserStatus.ACTIVE },
      });
      await prisma.permissionEntry.updateMany({
        where: { nodeId, userId: actorId },
        data: { role: DocumentRole.EDITOR },
      });
    },
  );

  it('keeps a failed save retryable through status 4 and finalizes its later callback', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const callback = new URL(
      (created.config.editorConfig as { callbackUrl: string }).callbackUrl,
    );
    const capability = callback.searchParams.get('capability')!;
    const artifactId = randomUUID();
    const bytes = Buffer.from('status four retry');
    const pathname = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      created.session.id,
      artifactId,
    );
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, bytes);
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: {
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(bytes.length),
        stagedSha256: createHash('sha256').update(bytes).digest('hex'),
        stagedAt: new Date(),
      },
    });
    const failingStorage: StorageService = {
      putStream: async () => {
        throw new Error('temporary storage failure');
      },
      openReadStream: objectStorage.openReadStream.bind(objectStorage),
      stat: objectStorage.stat.bind(objectStorage),
      exists: objectStorage.exists.bind(objectStorage),
      delete: objectStorage.delete.bind(objectStorage),
    };
    const failingService = new EditorSessionService(
      database,
      authorization,
      new JwtService(),
      config,
      {
        uploadTempRoot: '/tmp/dochub-editor-test',
        uploadMaxBytes: 1024 * 1024,
        root: '/tmp/dochub-editor-storage',
        driver: 'local',
      },
      failingStorage,
    );
    const token = (status: number) =>
      new JwtService().sign(
        { status, key: created.config.document.key },
        { secret: config.jwtSecret, algorithm: 'HS256' },
      );
    await expect(
      failingService.handleCallback(created.session.id, capability, {
        status: 2,
        key: created.config.document.key,
        token: token(2),
      }),
    ).resolves.toEqual({ error: 1 });
    await expect(stat(pathname)).resolves.toBeDefined();
    await expect(
      service.handleCallback(created.session.id, capability, {
        status: 4,
        key: created.config.document.key,
        token: token(4),
      }),
    ).resolves.toEqual({ error: 0 });
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({
      status: 'ACTIVE',
      finalizedFileVersionId: null,
    });
    await expect(
      service.handleCallback(created.session.id, capability, {
        status: 2,
        key: created.config.document.key,
        token: token(2),
      }),
    ).resolves.toEqual({ error: 0 });
    const finalized = await prisma.editorSession.findUniqueOrThrow({
      where: { id: created.session.id },
      include: { finalizedFileVersion: true },
    });
    expect(finalized).toMatchObject({
      status: 'CLOSED',
      finalizedAt: expect.any(Date),
    });
    expect(finalized.finalizedFileVersionId).toBe(
      finalized.finalizedFileVersion!.id,
    );
    permanentKeys.push(finalized.finalizedFileVersion!.storageKey);
    versionIds.push(finalized.finalizedFileVersionId!);
    await expect(stat(pathname)).rejects.toBeTruthy();
    const count = await prisma.fileVersion.count({ where: { fileId } });
    await expect(
      service.handleCallback(created.session.id, capability, {
        status: 2,
        key: created.config.document.key,
        token: token(2),
      }),
    ).resolves.toEqual({ error: 0 });
    await expect(prisma.fileVersion.count({ where: { fileId } })).resolves.toBe(
      count,
    );
  });

  it('accepts one exact final save callback after an EDIT UI close was requested', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const artifactId = randomUUID();
    const bytes = Buffer.from('final callback after graceful close');
    const pathname = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      created.session.id,
      artifactId,
    );
    await mkdir(path.dirname(pathname), { recursive: true });
    await writeFile(pathname, bytes);
    await prisma.editorSession.update({
      where: { id: created.session.id },
      // This is the persisted state produced by close() before it waits for
      // the bounded server-side completion contract.
      data: {
        closedAt: new Date(),
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(bytes.length),
        stagedSha256: createHash('sha256').update(bytes).digest('hex'),
        stagedAt: new Date(),
      },
    });
    const callback = new URL(
      (created.config.editorConfig as { callbackUrl: string }).callbackUrl,
    );
    const capability = callback.searchParams.get('capability')!;
    const token = new JwtService().sign(
      { status: 2, key: created.config.document.key },
      { secret: config.jwtSecret, algorithm: 'HS256' },
    );
    await expect(
      service.handleCallback(created.session.id, capability, {
        status: 2,
        key: created.config.document.key,
        token,
      }),
    ).resolves.toEqual({ error: 0 });
    const finalized = await prisma.editorSession.findUniqueOrThrow({
      where: { id: created.session.id },
      include: { finalizedFileVersion: true },
    });
    expect(finalized).toMatchObject({ status: 'CLOSED' });
    expect(finalized.finalizedFileVersion?.source).toBe('EDITOR');
    permanentKeys.push(finalized.finalizedFileVersion!.storageKey);
    versionIds.push(finalized.finalizedFileVersionId!);
    await expect(
      service.handleCallback(created.session.id, capability, {
        status: 2,
        key: created.config.document.key,
        token,
      }),
    ).resolves.toEqual({ error: 0 });
    await expect(
      prisma.fileVersion.count({ where: { fileId } }),
    ).resolves.toBe(finalized.finalizedFileVersion!.versionNumber);
  });

  it('expires a no-change graceful EDIT close without creating a version', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    const before = await prisma.fileVersion.count({ where: { fileId } });
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: { closedAt: new Date(0) },
    });
    await expect(
      service.closeExpiredEditSessions(new Date(60_001)),
    ).resolves.toMatchObject({ count: 1 });
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({
      status: 'CLOSED',
      finalizedFileVersionId: null,
    });
    await expect(prisma.fileVersion.count({ where: { fileId } })).resolves.toBe(
      before,
    );
  });

  it('closes an abandoned EDIT session after its callback capability lifetime', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const created = await service.create(actorId, nodeId, 'EDIT');
    await prisma.editorSession.update({
      where: { id: created.session.id },
      data: { createdAt: new Date(0) },
    });
    await expect(
      service.closeExpiredEditSessions(new Date(3_600_001)),
    ).resolves.toMatchObject({ count: 1 });
    await expect(
      prisma.editorSession.findUniqueOrThrow({
        where: { id: created.session.id },
      }),
    ).resolves.toMatchObject({ status: 'CLOSED', closedAt: null });
  });

  it('rejects a second editor session that becomes stale after another save', async () => {
    await prisma.permissionEntry.updateMany({
      where: { nodeId, userId: actorId },
      data: { role: DocumentRole.EDITOR },
    });
    const [first, second] = await Promise.all([
      service.create(actorId, nodeId, 'EDIT'),
      service.create(actorId, nodeId, 'EDIT'),
    ]);
    const stage = async (sessionId: string, contents: string) => {
      const artifactId = randomUUID();
      const bytes = Buffer.from(contents);
      const pathname = path.join(
        '/tmp/dochub-editor-test',
        'editor',
        sessionId,
        artifactId,
      );
      await mkdir(path.dirname(pathname), { recursive: true });
      await writeFile(pathname, bytes);
      await prisma.editorSession.update({
        where: { id: sessionId },
        data: {
          stagedArtifactId: artifactId,
          stagedSizeBytes: BigInt(bytes.length),
          stagedSha256: createHash('sha256').update(bytes).digest('hex'),
          stagedAt: new Date(),
        },
      });
      return pathname;
    };
    await stage(first.session.id, 'first editor wins');
    const stalePath = await stage(second.session.id, 'stale editor edit');
    const finalizer = service as unknown as {
      finalizeStagedDocument(id: string): Promise<void>;
    };
    await finalizer.finalizeStagedDocument(first.session.id);
    const winner = await prisma.editorSession.findUniqueOrThrow({
      where: { id: first.session.id },
      include: { finalizedFileVersion: true },
    });
    permanentKeys.push(winner.finalizedFileVersion!.storageKey);
    versionIds.push(winner.finalizedFileVersionId!);
    await expect(
      finalizer.finalizeStagedDocument(second.session.id),
    ).rejects.toBeTruthy();
    const file = await prisma.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(file.currentVersionId).toBe(winner.finalizedFileVersionId);
    expect(file.versionCounter).toBe(
      winner.finalizedFileVersion!.versionNumber,
    );
    expect(await prisma.fileVersion.count({ where: { fileId } })).toBe(
      file.versionCounter,
    );
    await expect(stat(stalePath)).resolves.toBeDefined();
  });

  it('allows exactly one concurrent upload or editor transition from the same base', async () => {
    const editor = await service.create(actorId, nodeId, 'EDIT');
    const artifactId = randomUUID();
    const editedBytes = Buffer.from('editor race edit');
    const editorPath = path.join(
      '/tmp/dochub-editor-test',
      'editor',
      editor.session.id,
      artifactId,
    );
    await mkdir(path.dirname(editorPath), { recursive: true });
    await writeFile(editorPath, editedBytes);
    await prisma.editorSession.update({
      where: { id: editor.session.id },
      data: {
        stagedArtifactId: artifactId,
        stagedSizeBytes: BigInt(editedBytes.length),
        stagedSha256: createHash('sha256').update(editedBytes).digest('hex'),
        stagedAt: new Date(),
      },
    });
    const uploadPath = path.join(
      '/tmp/dochub-editor-test',
      `upload-${randomUUID()}.docx`,
    );
    const uploadBytes = Buffer.from('upload race edit');
    await writeFile(uploadPath, uploadBytes);
    const finalizer = service as unknown as {
      finalizeStagedDocument(id: string): Promise<void>;
    };
    const [editorResult, uploadResult] = await Promise.allSettled([
      finalizer.finalizeStagedDocument(editor.session.id),
      files.createVersion(actorId, nodeId, {
        tempPath: uploadPath,
        originalFilename: 'race.docx',
        declaredMimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sizeBytes: BigInt(uploadBytes.length),
        sha256: createHash('sha256').update(uploadBytes).digest('hex'),
        parentId: null,
      }),
    ]);
    expect(
      [editorResult, uploadResult].filter(
        (result) => result.status === 'fulfilled',
      ),
    ).toHaveLength(1);
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
    if (editorResult.status === 'fulfilled') {
      const row = await prisma.editorSession.findUniqueOrThrow({
        where: { id: editor.session.id },
        include: { finalizedFileVersion: true },
      });
      permanentKeys.push(row.finalizedFileVersion!.storageKey);
      versionIds.push(row.finalizedFileVersionId!);
      await expect(stat(uploadPath)).resolves.toBeDefined();
    } else {
      await expect(stat(editorPath)).resolves.toBeDefined();
      const winning = versions.at(-1)!;
      permanentKeys.push(winning.storageKey);
      versionIds.push(winning.id);
    }
    await rm(uploadPath, { force: true });
  });

  it('validates fetch capabilities before a caller can open storage', async () => {
    const created = await service.create(actorId, nodeId);
    const source = new URL(created.config.document.url);
    const token = source.searchParams.get('token')!;
    await expect(
      service.authorizeFetch(created.session.id, token),
    ).resolves.toMatchObject({ nodeId, versionId: versionIds.at(-1) });
    await expect(
      service.authorizeFetch(randomUUID(), token),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.authorizeFetch(created.session.id, `${token}x`),
    ).rejects.toMatchObject({ status: 404 });
    await service.close(actorId, created.session.id);
    await expect(
      service.close(actorId, created.session.id),
    ).resolves.toMatchObject({ status: 'CLOSED' });
    await expect(
      service.authorizeFetch(created.session.id, token),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects expired, wrong-version, wrong-audience, revoked, and trashed fetches', async () => {
    const created = await service.create(actorId, nodeId);
    const token = new URL(created.config.document.url).searchParams.get(
      'token',
    )!;
    const jwt = new JwtService();
    const forge = (payload: object, options: object = {}) =>
      jwt.sign(
        {
          aud: 'onlyoffice-file-fetch',
          sessionId: created.session.id,
          fileVersionId: versionIds.at(-1),
          purpose: 'onlyoffice-file-fetch',
          ...payload,
        },
        { secret: config.fetchTokenSecret, algorithm: 'HS256', ...options },
      );
    await expect(
      service.authorizeFetch(created.session.id, forge({}, { expiresIn: -1 })),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.authorizeFetch(
        created.session.id,
        forge({ fileVersionId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.authorizeFetch(
        created.session.id,
        forge({ aud: 'wrong-audience' }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.permissionEntry.deleteMany({
      where: { nodeId, userId: actorId },
    });
    await expect(
      service.authorizeFetch(created.session.id, token),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.permissionEntry.create({
      data: { nodeId, userId: actorId, role: DocumentRole.VIEWER },
    });
    const operation = await prisma.trashOperation.create({
      data: {
        rootNodeId: nodeId,
        trashedById: actorId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: operation.id },
    });
    await expect(
      service.authorizeFetch(created.session.id, token),
    ).rejects.toMatchObject({ status: 404 });
    await prisma.node.update({
      where: { id: nodeId },
      data: { trashOperationId: null },
    });
    await prisma.trashOperation.delete({ where: { id: operation.id } });
  });
});
