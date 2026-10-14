import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  FileBackingType,
  FileProcessingTaskStatus,
  FileProcessingTaskType,
  FileRevisionProvider,
  FileRevisionSource,
  NodeType,
  PrismaClient,
  UserStatus,
} from '@dochub/database';
import { TikaClient } from '../src/tika/tika.client.js';
import {
  RevisionContentReaderError,
  type RevisionContentReader,
} from '../src/file-processing/revision-content-reader.js';
import { RevisionFileProcessingService } from '../src/file-processing/revision-file-processing.service.js';

const database = new PrismaClient({
  datasources: { db: { url: process.env.WORKER_TEST_DATABASE_URL } },
});

class MemoryRevisionReader implements RevisionContentReader {
  readonly content = new Map<string, string>();

  async openVersion(_objectId: string, providerVersionId: string) {
    const value = this.content.get(providerVersionId);
    if (value === undefined) throw new Error('Missing fixture revision');
    return Readable.from([Buffer.from(value)]);
  }
}

class BlockingRevisionReader extends MemoryRevisionReader {
  private readonly releaseGate: Promise<void>;
  private releaseGateResolve!: () => void;
  private startedResolve!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve;
  });

  constructor() {
    super();
    this.releaseGate = new Promise<void>((resolve) => {
      this.releaseGateResolve = resolve;
    });
  }

  release(): void {
    this.releaseGateResolve();
  }

  override async openVersion(objectId: string, providerVersionId: string) {
    if (providerVersionId === 'provider-R1') {
      this.startedResolve();
      await this.releaseGate;
    }
    return super.openVersion(objectId, providerVersionId);
  }
}

class FlakyRevisionReader extends MemoryRevisionReader {
  private failNext = true;

  override async openVersion(objectId: string, providerVersionId: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new RevisionContentReaderError('temporary provider failure', true);
    }
    return super.openVersion(objectId, providerVersionId);
  }
}

const config = {
  pollSeconds: 60,
  batchSize: 20,
  concurrency: 1,
  leaseSeconds: 60,
  maxAttempts: 3,
  tikaUrl: new URL('http://127.0.0.1:1'),
  tikaRequestTimeoutSeconds: 10,
  tikaMaxTextBytes: 1024,
  extractionMaxBytes: 1024,
  extractionMaxChars: 1024,
  outboxBatchSize: 50,
};

async function fixture(revision = 'R1', text = 'alpha báo cáo') {
  const suffix = randomUUID();
  const user = await database.user.create({
    data: {
      email: `processing-${suffix}@example.test`,
      normalizedEmail: `processing-${suffix}@example.test`,
      displayName: 'Processing tester',
      status: UserStatus.ACTIVE,
    },
  });
  const integration = await database.googleDriveIntegration.create({
    data: { singletonKey: `test-${suffix}` },
  });
  const node = await database.node.create({
    data: {
      type: NodeType.FILE,
      name: `report-${suffix}.txt`,
      normalizedName: `report-${suffix}.txt`,
      createdById: user.id,
    },
  });
  const driveFile = await database.driveFile.create({
    data: {
      driveIntegrationId: integration.id,
      driveFileId: `object-${suffix}`,
      name: node.name,
      mimeType: 'text/plain',
      normalizedType: 'BINARY',
      sizeBytes: BigInt(Buffer.byteLength(text)),
    },
  });
  const file = await database.file.create({
    data: {
      nodeId: node.id,
      backingType: FileBackingType.GOOGLE_DRIVE,
      driveFileId: driveFile.id,
      revisionSequence: 1,
    },
  });
  await database.fileRevision.create({
    data: {
      fileId: file.id,
      sequence: 1,
      provider: FileRevisionProvider.GOOGLE_DRIVE,
      providerVersionId: `provider-${revision}`,
      storageRevision: revision,
      sizeBytes: BigInt(Buffer.byteLength(text)),
      source: FileRevisionSource.INITIAL,
      createdById: user.id,
    },
  });
  return { file, node, revision, providerRevision: `provider-${revision}`, text };
}

function worker(reader: MemoryRevisionReader) {
  return new RevisionFileProcessingService(
    database,
    reader,
    new TikaClient(config.tikaUrl, 1000, config.tikaMaxTextBytes),
    config,
  );
}

describe('RevisionFileProcessingService integration', () => {
  it('coalesces duplicate content events and publishes a current revision index', async () => {
    const source = await fixture();
    const reader = new MemoryRevisionReader();
    reader.content.set(source.providerRevision, source.text);
    await database.outboxEvent.createMany({
      data: [1, 2].map(() => ({
        eventType: 'FILE_CONTENT_CHANGED',
        aggregateType: 'FILE',
        aggregateId: source.file.id,
        payload: { fileId: source.file.id, nodeId: source.node.id, reason: 'UPLOAD' },
      })),
    });
    const service = worker(reader);
    await service.runCycle();
    await service.runCycle();
    await expect(database.fileProcessingTask.count({
      where: { fileId: source.file.id, targetRevision: source.revision, type: FileProcessingTaskType.TEXT_EXTRACTION },
    })).resolves.toBe(1);
    await expect(database.searchDocument.findUniqueOrThrow({ where: { fileId: source.file.id } })).resolves.toMatchObject({
      indexedRevision: source.revision,
      fileVersionId: null,
      contentText: source.text,
    });
  });

  it('marks an older target stale and never lets it replace a newer index', async () => {
    const source = await fixture('R1', 'alpha only');
    const reader = new MemoryRevisionReader();
    reader.content.set(source.providerRevision, source.text);
    await database.fileProcessingTask.create({
      data: { fileId: source.file.id, targetRevision: 'R1', type: FileProcessingTaskType.TEXT_EXTRACTION },
    });
    await database.fileRevision.create({
      data: {
        fileId: source.file.id,
        sequence: 2,
        provider: FileRevisionProvider.GOOGLE_DRIVE,
        providerVersionId: 'provider-R2',
        storageRevision: 'R2',
        sizeBytes: 9n,
        source: FileRevisionSource.MANUAL_SAVE,
      },
    });
    await database.file.update({ where: { id: source.file.id }, data: { revisionSequence: 2 } });
    reader.content.set('provider-R2', 'beta only');
    await database.fileProcessingTask.create({
      data: { fileId: source.file.id, targetRevision: 'R2', type: FileProcessingTaskType.TEXT_EXTRACTION },
    });
    const service = worker(reader);
    await service.runCycle();
    await service.runCycle();
    await expect(database.fileProcessingTask.findUniqueOrThrow({
      where: { fileId_targetRevision_type: { fileId: source.file.id, targetRevision: 'R1', type: FileProcessingTaskType.TEXT_EXTRACTION } },
    })).resolves.toMatchObject({ status: FileProcessingTaskStatus.COMPLETED, lastError: 'STALE_REVISION' });
    await expect(database.searchDocument.findUniqueOrThrow({ where: { fileId: source.file.id } })).resolves.toMatchObject({
      indexedRevision: 'R2',
      contentText: 'beta only',
    });
  });

  it('retries a transient provider read and publishes one final index', async () => {
    const source = await fixture('R1', 'transient content');
    const reader = new FlakyRevisionReader();
    reader.content.set(source.providerRevision, source.text);
    await database.fileProcessingTask.create({
      data: {
        fileId: source.file.id,
        targetRevision: 'R1',
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });
    const service = worker(reader);

    await service.runCycle();
    const retry = await database.fileProcessingTask.findUniqueOrThrow({
      where: {
        fileId_targetRevision_type: {
          fileId: source.file.id,
          targetRevision: 'R1',
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      },
    });
    expect(retry).toMatchObject({
      status: FileProcessingTaskStatus.PENDING,
      attemptCount: 1,
      lastError: 'TRANSIENT_STORAGE_ERROR',
    });
    await database.fileProcessingTask.update({
      where: { id: retry.id },
      data: { availableAt: new Date() },
    });
    await service.runCycle();
    await service.runCycle();

    await expect(
      database.fileProcessingTask.findUniqueOrThrow({ where: { id: retry.id } }),
    ).resolves.toMatchObject({
      status: FileProcessingTaskStatus.COMPLETED,
      attemptCount: 2,
    });
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: source.file.id },
      }),
    ).resolves.toMatchObject({
      indexedRevision: 'R1',
      contentText: 'transient content',
    });
  });

  it('fences publication when the current revision changes during extraction', async () => {
    const source = await fixture('R1', 'alpha only');
    const reader = new BlockingRevisionReader();
    reader.content.set(source.providerRevision, source.text);
    const r1Task = await database.fileProcessingTask.create({
      data: {
        fileId: source.file.id,
        targetRevision: 'R1',
        type: FileProcessingTaskType.TEXT_EXTRACTION,
      },
    });

    const r1Cycle = worker(reader).runCycle();
    await reader.started;
    try {
      await database.fileRevision.create({
        data: {
          fileId: source.file.id,
          sequence: 2,
          provider: FileRevisionProvider.GOOGLE_DRIVE,
          providerVersionId: 'provider-R2-during-extraction',
          storageRevision: 'R2-during-extraction',
          sizeBytes: 9n,
          source: FileRevisionSource.MANUAL_SAVE,
        },
      });
      await database.file.update({
        where: { id: source.file.id },
        data: { revisionSequence: 2 },
      });
      reader.content.set('provider-R2-during-extraction', 'beta only');
      await database.fileProcessingTask.create({
        data: {
          fileId: source.file.id,
          targetRevision: 'R2-during-extraction',
          type: FileProcessingTaskType.TEXT_EXTRACTION,
        },
      });

      const r2Worker = worker(reader);
      await r2Worker.runCycle();
      await r2Worker.runCycle();
    } finally {
      reader.release();
      await r1Cycle;
    }

    await expect(
      database.fileProcessingTask.findUniqueOrThrow({ where: { id: r1Task.id } }),
    ).resolves.toMatchObject({
      status: FileProcessingTaskStatus.COMPLETED,
      lastError: 'STALE_REVISION',
    });
    await expect(
      database.searchDocument.findUniqueOrThrow({
        where: { fileId: source.file.id },
      }),
    ).resolves.toMatchObject({
      indexedRevision: 'R2-during-extraction',
      contentText: 'beta only',
    });
  });

  it('replaces phrase A with phrase B after a finalized content-change event', async () => {
    const source = await fixture('R1', 'phrase A');
    const reader = new MemoryRevisionReader();
    reader.content.set(source.providerRevision, source.text);
    await database.outboxEvent.create({
      data: {
        eventType: 'FILE_CONTENT_CHANGED',
        aggregateType: 'FILE',
        aggregateId: source.file.id,
        payload: { fileId: source.file.id, nodeId: source.node.id, reason: 'UPLOAD' },
      },
    });
    const service = worker(reader);
    await service.runCycle();
    await service.runCycle();
    await database.fileRevision.create({
      data: {
        fileId: source.file.id,
        sequence: 2,
        provider: FileRevisionProvider.GOOGLE_DRIVE,
        providerVersionId: 'provider-R2-edit',
        storageRevision: 'R2-edit',
        sizeBytes: 8n,
        source: FileRevisionSource.MANUAL_SAVE,
      },
    });
    await database.file.update({ where: { id: source.file.id }, data: { revisionSequence: 2 } });
    reader.content.set('provider-R2-edit', 'phrase B');
    await database.outboxEvent.create({
      data: {
        eventType: 'FILE_CONTENT_CHANGED',
        aggregateType: 'FILE',
        aggregateId: source.file.id,
        payload: { fileId: source.file.id, nodeId: source.node.id, reason: 'MANUAL_SAVE' },
      },
    });
    await service.runCycle();
    await service.runCycle();
    await expect(database.searchDocument.findUniqueOrThrow({ where: { fileId: source.file.id } })).resolves.toMatchObject({
      indexedRevision: 'R2-edit',
      contentText: 'phrase B',
    });
  });
});
