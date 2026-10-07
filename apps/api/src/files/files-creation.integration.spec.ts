import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentRole,
  FileVersionSource,
  GeneralAccessRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import { FileValidationService } from './file-validation.service.js';
import { FileReadService } from './file-read.service.js';
import type { TempUpload } from './file-upload.types.js';
import { OfficeFileKind } from './office-template.service.js';
import { FilesService } from './files.service.js';
import { NodesService } from '../nodes/nodes.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;

withDatabase('root creation access policy integration', () => {
  const suffix = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const viewerId = randomUUID();
  const pendingId = randomUUID();
  const suspendedId = randomUUID();
  const nodeIds = new Set<string>();
  const fileIds = new Set<string>();
  const storageRoot = `/tmp/dochub-root-creation-${suffix}`;
  const storage = new LocalFileStorage(storageRoot);
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const files = new FilesService(
    database,
    authorization,
    new FileValidationService(),
    storage,
  );
  const reads = new FileReadService(database, authorization, storage);
  const nodes = new NodesService(database, authorization);
  const createdVersionIds = new Set<string>();
  const createdOfficeNodeIds: string[] = [];

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          email: `root-policy-admin-${suffix}@example.test`,
          normalizedEmail: `root-policy-admin-${suffix}@example.test`,
          displayName: 'Root policy administrator',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
        {
          id: memberId,
          email: `root-policy-member-${suffix}@example.test`,
          normalizedEmail: `root-policy-member-${suffix}@example.test`,
          displayName: 'Root policy member',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.DOCUMENT_MANAGER,
        },
        {
          id: viewerId,
          email: `root-policy-viewer-${suffix}@example.test`,
          normalizedEmail: `root-policy-viewer-${suffix}@example.test`,
          displayName: 'Root policy viewer',
          status: UserStatus.ACTIVE,
        },
        {
          id: pendingId,
          email: `root-policy-pending-${suffix}@example.test`,
          normalizedEmail: `root-policy-pending-${suffix}@example.test`,
          displayName: 'Root policy pending',
          status: UserStatus.PENDING_APPROVAL,
        },
        {
          id: suspendedId,
          email: `root-policy-suspended-${suffix}@example.test`,
          normalizedEmail: `root-policy-suspended-${suffix}@example.test`,
          displayName: 'Root policy suspended',
          status: UserStatus.SUSPENDED,
        },
      ],
    });
  });

  afterAll(async () => {
    const ids = [...nodeIds];
    const versionIds = [...createdVersionIds];
    const keys = await prisma.fileVersion.findMany({
      where: { id: { in: versionIds } },
      select: { storageKey: true },
    });
    await prisma.auditLog.deleteMany({
      where: { resourceId: { in: [...ids, ...versionIds] } },
    });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    if (fileIds.size > 0) {
      await prisma.file.updateMany({
        where: { id: { in: [...fileIds] } },
        data: { currentVersionId: null },
      });
      await prisma.fileVersion.deleteMany({
        where: { id: { in: versionIds } },
      });
      await prisma.file.deleteMany({ where: { id: { in: [...fileIds] } } });
    }
    await prisma.node.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({
      where: {
        id: { in: [adminId, memberId, viewerId, pendingId, suspendedId] },
      },
    });
    await Promise.all(keys.map(({ storageKey }) => storage.delete(storageKey)));
    await rm(storageRoot, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  it('lets an active member create every supported root item with viewer general access', async () => {
    const folder = await nodes.createFolder(memberId, {
      name: `Member root folder ${suffix}`,
    });
    nodeIds.add(folder.id);

    const rootUpload = await temporaryUpload(
      'member-root.pdf',
      Buffer.from('%PDF-1.7\nmember root upload\n'),
      null,
    );
    const uploaded = await files.createInitial(memberId, rootUpload);
    await rm(path.dirname(rootUpload.tempPath), {
      recursive: true,
      force: true,
    });
    nodeIds.add(uploaded.node.id);
    fileIds.add(uploaded.file.id);
    createdVersionIds.add(uploaded.version.id);
    const generalAccessRead = await reads.open(
      viewerId,
      uploaded.node.id,
      DocumentCapability.PREVIEW,
      undefined,
    );
    generalAccessRead.stream.destroy();

    for (const kind of [
      OfficeFileKind.DOCX,
      OfficeFileKind.XLSX,
      OfficeFileKind.PPTX,
    ]) {
      const created = await files.createOffice(memberId, kind, null);
      nodeIds.add(created.node.id);
      fileIds.add(created.file.id);
      createdVersionIds.add(created.version.id);
      createdOfficeNodeIds.push(created.node.id);
    }

    const createdNodes = await prisma.node.findMany({
      where: { id: { in: [...nodeIds] } },
      select: {
        id: true,
        parentId: true,
        type: true,
        generalAccessRole: true,
      },
    });
    expect(createdNodes).toHaveLength(5);
    expect(createdNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: folder.id,
          parentId: null,
          type: NodeType.FOLDER,
          generalAccessRole: GeneralAccessRole.VIEWER,
        }),
      ]),
    );
    expect(
      createdNodes.every(
        (node) =>
          node.parentId === null &&
          node.generalAccessRole === GeneralAccessRole.VIEWER,
      ),
    ).toBe(true);

    const ownerEntries = await prisma.permissionEntry.findMany({
      where: { nodeId: { in: [...nodeIds] }, userId: memberId },
      select: { nodeId: true, role: true },
    });
    expect(ownerEntries).toHaveLength(5);
    expect(
      ownerEntries.every((entry) => entry.role === DocumentRole.OWNER),
    ).toBe(true);

    const versionRows = await prisma.fileVersion.findMany({
      where: { fileId: { in: [...fileIds] } },
      select: { fileId: true, source: true, versionNumber: true },
    });
    expect(
      versionRows.filter(
        (version) => version.source === FileVersionSource.SYSTEM,
      ),
    ).toHaveLength(3);
    expect(
      versionRows.filter(
        (version) => version.source === FileVersionSource.UPLOAD,
      ),
    ).toHaveLength(1);

    await expect(
      prisma.auditLog.findMany({
        where: {
          resourceId: { in: [...nodeIds] },
          actorId: memberId,
          action: { in: ['FOLDER_CREATED', 'FILE_UPLOADED', 'FILE_CREATED'] },
        },
      }),
    ).resolves.toHaveLength(5);
  });

  it('keeps protected nested folders non-writable for an active member', async () => {
    const protectedFolder = await nodes.createFolder(adminId, {
      name: `Protected nested folder ${suffix}`,
    });
    nodeIds.add(protectedFolder.id);
    await prisma.permissionEntry.create({
      data: {
        nodeId: protectedFolder.id,
        userId: memberId,
        role: DocumentRole.VIEWER,
        createdById: adminId,
      },
    });

    await expect(
      nodes.createFolder(memberId, {
        name: `Denied nested folder ${suffix}`,
        parentId: protectedFolder.id,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      files.createOffice(memberId, OfficeFileKind.DOCX, protectedFolder.id),
    ).rejects.toMatchObject({ status: 403 });
    const deniedUpload = await temporaryUpload(
      'denied-nested.pdf',
      Buffer.from('%PDF-1.7\ndenied nested upload\n'),
      protectedFolder.id,
    );
    await expect(
      files.createInitial(memberId, deniedUpload),
    ).rejects.toMatchObject({ status: 403 });
    await rm(path.dirname(deniedUpload.tempPath), {
      recursive: true,
      force: true,
    });

    await expect(
      prisma.node.findFirst({
        where: { parentId: protectedFolder.id, name: { contains: 'Denied' } },
      }),
    ).resolves.toBeNull();
  });

  it('denies pending, suspended, and unknown root actors before creating artifacts', async () => {
    const actorIds = [pendingId, suspendedId, randomUUID()];
    const storageBefore = await storageFiles(storageRoot);
    const before = await prisma.node.count({
      where: { createdById: { in: actorIds } },
    });
    for (const actorId of actorIds) {
      await expect(
        nodes.createFolder(actorId, { name: `Denied folder ${actorId}` }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        files.createOffice(actorId, OfficeFileKind.XLSX, null),
      ).rejects.toMatchObject({ status: 403 });
      const deniedUpload = await temporaryUpload(
        `denied-${actorId}.pdf`,
        Buffer.from('%PDF-1.7\ndenied root upload\n'),
        null,
      );
      await expect(
        files.createInitial(actorId, deniedUpload),
      ).rejects.toMatchObject({ status: 403 });
      await rm(path.dirname(deniedUpload.tempPath), {
        recursive: true,
        force: true,
      });
    }
    expect(
      await prisma.node.count({ where: { createdById: { in: actorIds } } }),
    ).toBe(before);
    expect(await storageFiles(storageRoot)).toEqual(storageBefore);
  });

  it('does not turn viewer general access into write access', async () => {
    const fileId = createdOfficeNodeIds[0];
    await prisma.permissionEntry.create({
      data: {
        nodeId: fileId,
        userId: viewerId,
        role: DocumentRole.VIEWER,
        createdById: adminId,
      },
    });
    await expect(
      nodes.renameNode(viewerId, fileId, {
        name: `viewer-rename-${suffix}.docx`,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      nodes.moveNode(viewerId, fileId, { parentId: null }),
    ).rejects.toMatchObject({ status: 403 });
    const deniedUpload = await temporaryUpload(
      'viewer-version.pdf',
      Buffer.from('%PDF-1.7\nviewer version\n'),
      null,
    );
    await expect(
      files.createVersion(viewerId, fileId, deniedUpload),
    ).rejects.toMatchObject({ status: 403 });
    await rm(path.dirname(deniedUpload.tempPath), {
      recursive: true,
      force: true,
    });
  });
});

async function temporaryUpload(
  filename: string,
  bytes: Buffer,
  parentId: string | null,
): Promise<TempUpload> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'dochub-root-upload-'),
  );
  const tempPath = path.join(directory, 'upload');
  await writeFile(tempPath, bytes);
  return {
    tempPath,
    originalFilename: filename,
    declaredMimeType: 'application/pdf',
    sizeBytes: BigInt(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    parentId,
  };
}

async function storageFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, {
      recursive: true,
    });
    return entries;
  } catch {
    return [];
  }
}
