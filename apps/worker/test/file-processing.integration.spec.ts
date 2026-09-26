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
        await (
          worker as unknown as {
            writeCurrentDocument(
              fileId: string,
              versionId: string,
              content: string,
            ): Promise<void>;
          }
        ).writeCurrentDocument(v1.fileId, v2.id, 'version two');
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
});
