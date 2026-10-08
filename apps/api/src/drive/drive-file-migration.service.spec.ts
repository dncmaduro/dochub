import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  DriveFileMigrationStatus,
  FileBackingType,
} from '@dochub/database';
import { DriveFileMigrationService } from './drive-file-migration.service.js';

const bytes = Buffer.from('%PDF-1.7 legacy content\n');
const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
const sourceMd5 = createHash('md5').update(bytes).digest('hex');

function harness(
  options: {
    stale?: boolean;
    activeEditor?: boolean;
    missingBytes?: boolean;
  } = {},
) {
  const fileId = randomUUID();
  const nodeId = randomUUID();
  const versionId = randomUUID();
  const connectionId = randomUUID();
  const driveRecordId = randomUUID();
  const files = new Map<string, any>();
  const migrations = new Map<string, any>();
  const audits: any[] = [];
  const source = {
    id: fileId,
    nodeId,
    backingType: options.stale ? FileBackingType.LOCAL : FileBackingType.LOCAL,
    driveFileId: null,
    currentVersionId: versionId,
    driveMigrations: [],
    node: { id: nodeId, name: 'legacy.pdf', parentId: null },
    currentVersion: {
      id: versionId,
      fileId,
      storageKey: `file/${fileId}/${versionId}`,
      originalFilename: 'legacy.pdf',
      mimeType: 'application/pdf',
      sizeBytes: BigInt(bytes.length),
      sha256: sourceSha256,
    },
  };
  files.set(fileId, source);
  const prisma: any = {
    file: {
      findUnique: vi.fn(async ({ where }: any) => files.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        const row = files.get(where.id);
        if (
          !row ||
          (where.driveFileId && row.driveFileId !== where.driveFileId)
        )
          return null;
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = files.get(where.id);
        Object.assign(row, data);
        return row;
      }),
      findMany: vi.fn(async () => [...files.values()]),
      count: vi.fn(
        async ({ where }: any) =>
          [...files.values()].filter(
            (row) => row.backingType === where.backingType,
          ).length,
      ),
    },
    node: {
      findMany: vi.fn(async () => [
        { id: nodeId, parentId: null, name: 'legacy.pdf' },
      ]),
    },
    editorSession: {
      findFirst: vi.fn(async () =>
        options.activeEditor ? { id: randomUUID() } : null,
      ),
    },
    driveFileMigration: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.fileId_sourceVersionId
          ? `${where.fileId_sourceVersionId.fileId}:${where.fileId_sourceVersionId.sourceVersionId}`
          : where.id;
        return (
          migrations.get(key) ??
          [...migrations.values()].find((item) => item.id === where.id) ??
          null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: randomUUID(),
          ...data,
          status: DriveFileMigrationStatus.PENDING,
          attempts: 0,
          driveIntegrationId: null,
          driveFileRecordId: null,
          remoteDriveFileId: null,
          leaseToken: null,
          leaseExpiresAt: null,
        };
        migrations.set(`${row.fileId}:${row.sourceVersionId}`, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = [...migrations.values()].find(
          (item) => item.id === where.id,
        );
        if (!row) throw new Error('migration missing');
        for (const [key, value] of Object.entries(data)) {
          if (
            typeof value === 'object' &&
            value !== null &&
            'increment' in value
          )
            row[key] += (value as any).increment;
          else row[key] = value;
        }
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = [...migrations.values()].find(
          (item) => item.id === where.id,
        );
        if (row) {
          for (const [key, value] of Object.entries(data)) {
            if (
              typeof value === 'object' &&
              value !== null &&
              'increment' in value
            )
              row[key] += (value as any).increment;
            else row[key] = value;
          }
        }
        return { count: row ? 1 : 0 };
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = `${where.fileId_sourceVersionId.fileId}:${where.fileId_sourceVersionId.sourceVersionId}`;
        const row = migrations.get(key);
        if (row) Object.assign(row, update);
        else migrations.set(key, { id: randomUUID(), ...create });
        return migrations.get(key);
      }),
      findFirst: vi.fn(
        async () =>
          [...migrations.values()].find(
            (row) => row.status === DriveFileMigrationStatus.COMPLETED,
          ) ?? null,
      ),
      findMany: vi.fn(async () => [...migrations.values()]),
    },
    driveFile: {
      upsert: vi.fn(async ({ create }: any) => ({
        id: driveRecordId,
        ...create,
      })),
    },
    auditLog: { create: vi.fn(async ({ data }: any) => audits.push(data)) },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) =>
    callback(prisma),
  );
  prisma.$queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings[0] ?? '';
    if (query.includes('DriveFileMigration')) {
      const row = [...migrations.values()][0];
      return row
        ? [
            {
              fileId,
              sourceVersionId: versionId,
              driveFileRecordId: driveRecordId,
              remoteDriveFileId: row.remoteDriveFileId,
              status: DriveFileMigrationStatus.VERIFIED,
            },
          ]
        : [];
    }
    return [
      {
        currentVersionId: options.stale ? randomUUID() : versionId,
        backingType: source.backingType,
        driveFileId: source.driveFileId,
      },
    ];
  });

  const storage = {
    stat: vi.fn(async () => {
      if (options.missingBytes) throw new Error('missing');
      return { sizeBytes: BigInt(bytes.length), modifiedAt: new Date() };
    }),
    openReadStream: vi.fn(async () => Readable.from([bytes])),
  };
  const remote = {
    id: 'remote-file-1',
    name: 'legacy.pdf',
    mimeType: 'application/pdf',
    size: String(bytes.length),
    md5Checksum: sourceMd5,
    driveId: 'company-drive',
    webViewLink: 'https://drive.google.com/file/d/remote-file-1/view',
    parents: ['physical-target'],
  };
  const drive = {
    withConfiguredWritableDrive: vi.fn(
      async (callback: (context: any) => Promise<unknown>) =>
        callback({
          accessToken: 'server',
          integrationId: connectionId,
          target: { type: 'SHARED_DRIVE', driveId: 'company-drive', parentFolderId: 'physical-target' },
        }),
    ),
    uploadBinaryWithContext: vi.fn(
      async (
        _context: any,
        _name: string,
        _mime: string,
        stream: AsyncIterable<Uint8Array>,
      ) => {
        for await (const _chunk of stream) {
          /* drain */
        }
        return remote;
      },
    ),
    getFileWithContext: vi.fn(async () => remote),
    deleteBinaryWithContext: vi.fn(async () => undefined),
  };
  const service = new DriveFileMigrationService(
    { prisma } as any,
    drive as any,
    storage as any,
  );
  return {
    service,
    prisma,
    drive,
    storage,
    files,
    migrations,
    audits,
    fileId,
    versionId,
    driveRecordId,
  };
}

describe('DriveFileMigrationService', () => {
  it('reports eligible and blocked inventory without mutation', async () => {
    const healthy = harness();
    const missing = harness({ missingBytes: true });
    const inventory = await healthy.service.inventory({
      fileId: healthy.fileId,
    });
    expect(inventory.items[0]).toMatchObject({
      eligibility: 'ELIGIBLE',
      currentVersionId: healthy.versionId,
    });
    expect(healthy.prisma.driveFileMigration.create).not.toHaveBeenCalled();
    const blocked = await missing.service.inventory({ fileId: missing.fileId });
    expect(blocked.items[0]).toMatchObject({
      eligibility: 'SOURCE_BYTES_MISSING',
      blockingReason: 'SOURCE_BYTES_MISSING',
    });
    const invalid = harness();
    invalid.files.get(invalid.fileId).currentVersionId = null;
    const invalidInventory = await invalid.service.inventory({
      fileId: invalid.fileId,
    });
    expect(invalidInventory.items[0]).toMatchObject({
      eligibility: 'MISSING_CURRENT_VERSION',
      blockingReason: 'CURRENT_VERSION_MISSING',
    });
  });

  it('uploads, verifies, and cuts over the same File without creating a Node', async () => {
    const h = harness();
    const status = await h.service.migrateFile(h.fileId);
    expect(status).toBe(DriveFileMigrationStatus.COMPLETED);
    expect(await h.service.migrateFile(h.fileId)).toBe(
      DriveFileMigrationStatus.COMPLETED,
    );
    expect(h.drive.uploadBinaryWithContext).toHaveBeenCalledTimes(1);
    expect(h.drive.getFileWithContext).toHaveBeenCalledWith(
      expect.anything(),
      'remote-file-1',
    );
    expect(h.files.get(h.fileId)).toMatchObject({
      backingType: FileBackingType.GOOGLE_DRIVE,
      driveFileId: h.driveRecordId,
    });
    expect(h.files.get(h.fileId).node.parentId).toBeNull();
    expect(h.drive.uploadBinaryWithContext).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: 'SHARED_DRIVE', driveId: 'company-drive', parentFolderId: 'physical-target' },
      }),
      'legacy.pdf',
      'application/pdf',
      expect.anything(),
    );
    expect(
      h.audits.some((row) => row.action === 'LOCAL_FILE_MIGRATION_COMPLETED'),
    ).toBe(true);
  });

  it('resumes a durable uploaded state without uploading a duplicate', async () => {
    const h = harness();
    const migration = {
      id: randomUUID(),
      fileId: h.fileId,
      sourceVersionId: h.versionId,
      sourceSha256,
      sourceSizeBytes: BigInt(bytes.length),
      status: DriveFileMigrationStatus.UPLOADED,
      attempts: 1,
      driveIntegrationId: null,
      driveFileRecordId: null,
      remoteDriveFileId: 'remote-file-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    h.migrations.set(`${h.fileId}:${h.versionId}`, migration);
    expect(await h.service.migrateFile(h.fileId)).toBe(
      DriveFileMigrationStatus.COMPLETED,
    );
    expect(h.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
    expect(h.drive.getFileWithContext).toHaveBeenCalledTimes(2);
  });

  it('refuses cutover when the local current version changes during upload', async () => {
    const h = harness({ stale: true });
    expect(await h.service.migrateFile(h.fileId)).toBe(
      DriveFileMigrationStatus.STALE,
    );
    expect(h.files.get(h.fileId).backingType).toBe(FileBackingType.LOCAL);
  });

  it('blocks active ONLYOFFICE editing and missing source bytes', async () => {
    const active = harness({ activeEditor: true });
    expect(
      await active.service.migrateFile(active.fileId),
    ).toBe(DriveFileMigrationStatus.BLOCKED);
    expect(active.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
    const missing = harness({ missingBytes: true });
    expect(
      await missing.service.migrateFile(missing.fileId),
    ).toBe(DriveFileMigrationStatus.BLOCKED);
    expect(missing.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
  });

  it('blocks a file with no authoritative current version', async () => {
    const h = harness();
    h.files.get(h.fileId).currentVersionId = null;
    expect(await h.service.migrateFile(h.fileId)).toBe(
      DriveFileMigrationStatus.BLOCKED,
    );
    expect(h.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
  });

  it('skips a file that is already Drive-backed', async () => {
    const h = harness();
    h.files.get(h.fileId).backingType = FileBackingType.GOOGLE_DRIVE;
    h.files.get(h.fileId).driveFileId = h.driveRecordId;
    expect(await h.service.migrateFile(h.fileId)).toBe(
      DriveFileMigrationStatus.COMPLETED,
    );
    expect(h.drive.uploadBinaryWithContext).not.toHaveBeenCalled();
  });

  it('rolls back to LOCAL after verifying the preserved current bytes', async () => {
    const h = harness();
    await h.service.migrateFile(h.fileId);
    expect(await h.service.rollback(h.fileId)).toBe(
      DriveFileMigrationStatus.ROLLED_BACK,
    );
    expect(h.files.get(h.fileId)).toMatchObject({
      backingType: FileBackingType.LOCAL,
      driveFileId: null,
    });
    expect(h.drive.deleteBinaryWithContext).not.toHaveBeenCalled();
  });

  it('uses the company integration without a migration owner user id', async () => {
    const h = harness();
    await h.service.migrateFile(h.fileId);
    expect(h.drive.withConfiguredWritableDrive).toHaveBeenCalled();
  });
});
