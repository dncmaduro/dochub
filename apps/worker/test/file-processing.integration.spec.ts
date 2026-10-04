import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  FileProcessingTaskType,
  PrismaClient,
  type FileProcessingTaskStatus,
} from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { FileProcessingService } from '../src/file-processing/file-processing.service.js';
import { TikaClient } from '../src/tika/tika.client.js';

function pdf(text: string): Buffer {
  const stream = Buffer.from(
    `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`,
    'latin1',
  );
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream.toString('latin1')}\nendstream`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [0];
  for (const [index, body] of bodies.entries()) {
    offsets.push(Buffer.concat(parts).length);
    parts.push(Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1'));
  }
  const xref = Buffer.concat(parts).length;
  parts.push(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
        .join(
          '',
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

describe('file processing with PostgreSQL, LocalFileStorage, and Tika', () => {
  let database: PrismaClient;
  let storage: LocalFileStorage;
  let root: string;
  let actorId: string;
  const nodeIds: string[] = [];

  beforeEach(async () => {
    database = new PrismaClient();
    actorId = randomUUID();
    root = await mkdtemp(join(tmpdir(), 'dochub-processing-'));
    storage = new LocalFileStorage(root);
    await database.user.create({
      data: {
        id: actorId,
        email: `${actorId}@processing.test`,
        normalizedEmail: `${actorId}@processing.test`,
        displayName: 'Processing fixture',
        status: 'ACTIVE',
      },
    });
  });
  afterEach(async () => {
    try {
      await database.file.updateMany({
        where: { nodeId: { in: nodeIds } },
        data: { currentVersionId: null },
      });
      await database.fileVersion.deleteMany({
        where: { file: { nodeId: { in: nodeIds } } },
      });
      await database.file.deleteMany({ where: { nodeId: { in: nodeIds } } });
      await database.node.deleteMany({ where: { id: { in: nodeIds } } });
      await database.user.delete({ where: { id: actorId } });
    } finally {
      await database.$disconnect();
      await rm(root, { recursive: true, force: true });
      nodeIds.length = 0;
    }
  });

  async function version(
    fileId?: string,
    text = 'Quarterly Báo cáo doanh thu 2026',
  ) {
    const nodeId = fileId ? undefined : randomUUID();
    let actualFileId = fileId;
    if (!actualFileId) {
      nodeIds.push(nodeId!);
      await database.node.create({
        data: {
          id: nodeId!,
          type: 'FILE',
          name: nodeId!,
          normalizedName: nodeId!,
          createdById: actorId,
        },
      });
      actualFileId = randomUUID();
      await database.file.create({
        data: { id: actualFileId, nodeId: nodeId! },
      });
    }
    const id = randomUUID();
    const storageKey = `processing/${actualFileId}/${id}`;
    await storage.putStream(storageKey, Readable.from(pdf(text)));
    const count = await database.fileVersion.count({
      where: { fileId: actualFileId },
    });
    await database.fileVersion.create({
      data: {
        id,
        fileId: actualFileId,
        versionNumber: count + 1,
        storageKey,
        originalFilename: 'fixture.pdf',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(pdf(text).length),
        sha256: id.replaceAll('-', '').padEnd(64, '0'),
        source: 'UPLOAD',
        createdById: actorId,
      },
    });
    await database.file.update({
      where: { id: actualFileId },
      data: { versionCounter: count + 1, currentVersionId: id },
    });
    return { id, fileId: actualFileId };
  }

  function service(
    tika: Pick<TikaClient, 'extractPlainText'> = new TikaClient(
      new URL(process.env.TIKA_URL ?? 'http://localhost:9998'),
      30_000,
      1024 * 1024,
    ),
  ) {
    return new FileProcessingService(database, storage, tika as TikaClient, {
      pollSeconds: 60,
      batchSize: 1,
      concurrency: 1,
      leaseSeconds: 60,
      maxAttempts: 5,
      tikaUrl: new URL(process.env.TIKA_URL ?? 'http://localhost:9998'),
      tikaRequestTimeoutSeconds: 30,
      tikaMaxTextBytes: 1024 * 1024,
    });
  }

  type ClaimedTask = {
    id: string;
    fileVersionId: string;
    attemptCount: number;
    leaseToken: string;
  };

  const internals = (worker: FileProcessingService) =>
    worker as unknown as {
      claimTasks(): Promise<ClaimedTask[]>;
      complete(task: ClaimedTask): Promise<void>;
      fail(task: ClaimedTask, error: unknown): Promise<void>;
      writeCurrentDocument(
        task: ClaimedTask,
        fileId: string,
        versionId: string,
        content: string,
      ): Promise<void>;
    };

  it('backfills one current searchable version idempotently and indexes it through real Tika', async () => {
    const current = await version();
    const worker = service();
    expect(await worker.backfillCurrentVersions()).toBe(1);
    expect(await worker.backfillCurrentVersions()).toBe(0);
    expect(
      await database.fileProcessingTask.count({
        where: {
          fileVersionId: current.id,
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      }),
    ).toBe(1);
    expect(await worker.runCycle()).toBe(1);
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: current.fileId },
      }),
    ).resolves.toMatchObject({
      fileVersionId: current.id,
      contentText: expect.stringContaining('Quarterly Báo cáo doanh thu 2026'),
    });
  });

  it('advances its batch cursor without duplicating work for unrelated current files', async () => {
    const first = await version(undefined, 'first current version');
    const second = await version(undefined, 'second current version');
    const worker = service();

    expect(await worker.backfillCurrentVersions()).toBe(1);
    expect(await worker.backfillCurrentVersions()).toBe(1);
    expect(await worker.backfillCurrentVersions()).toBe(0);
    expect(
      await database.fileProcessingTask.count({
        where: {
          fileVersionId: { in: [first.id, second.id] },
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      }),
    ).toBe(2);
  });

  it('does not let an out-of-order v1 completion overwrite v2 content', async () => {
    const v1 = await version(undefined, 'version one');
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: v1.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    let worker!: FileProcessingService;
    const tika = {
      extractPlainText: vi.fn(async () => {
        const v2 = await version(v1.fileId, 'version two');
        await database.fileProcessingTask.create({
          data: {
            fileVersionId: v2.id,
            type: FileProcessingTaskType.TEXT_EXTRACTION,
          },
        });
        await service({
          extractPlainText: vi.fn().mockResolvedValue('version two'),
        }).runCycle();
        return 'version one';
      }),
    };
    worker = service(tika);
    expect(await worker.runCycle()).toBe(1);
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: v1.fileId },
      }),
    ).resolves.toMatchObject({
      fileVersionId: expect.not.stringMatching(v1.id),
      contentText: 'version two',
    });
    const task = await database.fileProcessingTask.findUniqueOrThrow({
      where: {
        fileVersionId_type: {
          fileVersionId: v1.id,
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      },
    });
    expect(task.status as FileProcessingTaskStatus).toBe('COMPLETED');
  });

  it('keeps a Tika-unavailable task retryable and recovers when Tika returns', async () => {
    const current = await version();
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: current.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    const unavailable = service(
      new TikaClient(new URL('http://127.0.0.1:1'), 100, 1024 * 1024),
    );
    expect(await unavailable.runCycle()).toBe(1);
    const failedAttempt = await database.fileProcessingTask.findUniqueOrThrow({
      where: {
        fileVersionId_type: {
          fileVersionId: current.id,
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      },
    });
    expect(failedAttempt).toMatchObject({
      status: 'PENDING',
      lastError: 'TIKA_RETRYABLE',
    });
    await database.fileProcessingTask.update({
      where: { id: failedAttempt.id },
      data: { availableAt: new Date() },
    });
    expect(await service().runCycle()).toBe(1);
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: current.fileId },
      }),
    ).resolves.toMatchObject({ fileVersionId: current.id });
  });

  it('atomically gives two concurrent claimers one owner', async () => {
    const current = await version();
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: current.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    const [left, right] = await Promise.all([
      internals(service()).claimTasks(),
      internals(service()).claimTasks(),
    ]);
    expect(left.length + right.length).toBe(1);
    const task = await database.fileProcessingTask.findUniqueOrThrow({
      where: {
        fileVersionId_type: {
          fileVersionId: current.id,
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      },
    });
    expect(task).toMatchObject({ status: 'PROCESSING', attemptCount: 1 });
    expect(task.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('reclaims an expired lease and fences the stale owner', async () => {
    const current = await version();
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: current.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    const first = (await internals(service()).claimTasks())[0]!;
    await database.fileProcessingTask.update({
      where: { id: first.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    const second = (await internals(service()).claimTasks())[0]!;
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attemptCount).toBe(2);
    const worker = internals(service());
    await worker.writeCurrentDocument(
      second,
      current.fileId,
      current.id,
      'new owner content',
    );
    await worker.complete(second);
    await worker.writeCurrentDocument(
      first,
      current.fileId,
      current.id,
      'stale owner content',
    );
    await worker.fail(first, new Error('late worker'));
    await expect(
      database.fileProcessingTask.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).resolves.toMatchObject({
      status: 'COMPLETED',
      attemptCount: 2,
      leaseToken: null,
    });
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: current.fileId },
      }),
    ).resolves.toMatchObject({ contentText: 'new owner content' });
  });

  it('treats a missing immutable storage object as terminal without writing search state', async () => {
    const current = await version();
    await storage.delete(`processing/${current.fileId}/${current.id}`);
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: current.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    expect(await service().runCycle()).toBe(1);
    await expect(
      database.fileProcessingTask.findUniqueOrThrow({
        where: {
          fileVersionId_type: {
            fileVersionId: current.id,
            type: FileProcessingTaskType.TEXT_EXTRACTION,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      attemptCount: 1,
      lastError: 'STORAGE_NOT_FOUND',
    });
    await expect(
      database.searchDocument.findUnique({ where: { fileId: current.fileId } }),
    ).resolves.toBeNull();
  });

  it('does not resurrect a purged version when an already-claimed worker finishes', async () => {
    const current = await version();
    await database.fileProcessingTask.create({
      data: {
        fileVersionId: current.id,
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    const claimed = (await internals(service()).claimTasks())[0]!;
    await database.file.update({
      where: { id: current.fileId },
      data: { currentVersionId: null },
    });
    await database.fileVersion.delete({ where: { id: current.id } });
    await internals(service()).complete(claimed);
    await expect(
      database.fileProcessingTask.findUnique({ where: { id: claimed.id } }),
    ).resolves.toBeNull();
    await expect(
      database.searchDocument.findUnique({ where: { fileId: current.fileId } }),
    ).resolves.toBeNull();
  });
});
