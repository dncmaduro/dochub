import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import {
  FileProcessingTaskStatus,
  FileProcessingTaskType,
  OutboxStatus,
  Prisma,
  type PrismaClient,
} from '@dochub/database';
import { LocalFileStorage } from '@dochub/storage';
import { TikaClient, TikaClientError } from '../tika/tika.client.js';
import type { FileProcessingConfig } from './file-processing.config.js';
import { LegacyFileBackfillService } from './legacy-file-backfill.service.js';
import {
  extractNativeText,
  nativeExtractionSupported,
  NativeExtractionError,
} from './native-text-extractor.js';
import {
  type RevisionContentReader,
  RevisionContentReaderError,
} from './revision-content-reader.js';

type ClaimedTask = {
  id: string;
  fileId: string;
  targetRevision: string;
  type: FileProcessingTaskType;
  attemptCount: number;
  leaseToken: string;
};

type ProcessingFile = {
  fileId: string;
  nodeId: string;
  name: string;
  mimeType: string;
  sizeBytes: bigint | null;
  objectId: string;
  providerVersionId: string;
  targetRevision: string;
};

class ProcessingError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED'
      | 'MALFORMED'
      | 'LIMIT_EXCEEDED'
      | 'TRANSIENT_STORAGE_ERROR'
      | 'EXTRACTOR_ERROR'
      | 'TIMEOUT'
      | 'STALE_REVISION',
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = 'ProcessingError';
  }
}

/**
 * CP9's provider-neutral processing orchestrator. It consumes authoritative
 * FILE_CONTENT_CHANGED events, resolves the current FileRevision, and never
 * makes local FileVersion/storageKey data authoritative.
 */
export class RevisionFileProcessingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RevisionFileProcessingService.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopping = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly reader: RevisionContentReader,
    private readonly tika: TikaClient,
    private readonly config: FileProcessingConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.FILE_PROCESSING_MODE === 'backfill') {
      this.logger.log('File processing started in explicit backfill mode');
      return;
    }
    this.logger.log('Provider-revision file processing started');
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
    this.logger.log('Provider-revision file processing stopped');
  }

  runCycle(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processCycle().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  /** Explicit, resumable caller-controlled backfill; never runs at startup. */
  async enqueueBackfill(options: { cursor?: string; limit?: number; dryRun?: boolean } = {}) {
    const limit = Math.min(Math.max(options.limit ?? this.config.batchSize, 1), 500);
    const files = await this.database.file.findMany({
      where: {
        revisionSequence: { gt: 0 },
        node: { trashOperationId: null },
        ...(options.cursor ? { id: { gt: options.cursor } } : {}),
      },
      select: { id: true, revisionSequence: true, node: { select: { id: true, name: true, file: { select: { driveFile: { select: { mimeType: true } } } } } } },
      orderBy: { id: 'asc' },
      take: limit,
    });
    let enqueued = 0;
    for (const file of files) {
      const revision = await this.database.fileRevision.findUnique({
        where: { fileId_sequence: { fileId: file.id, sequence: file.revisionSequence } },
        select: { storageRevision: true },
      });
      const mimeType = file.node.file?.driveFile?.mimeType;
      if (!revision || !mimeType || !this.canExtract(mimeType, file.node.name)) continue;
      const existing = await this.database.searchDocument.findUnique({
        where: { fileId: file.id },
        select: { indexedRevision: true },
      });
      if (existing?.indexedRevision === revision.storageRevision) continue;
      if (!options.dryRun) await this.enqueueTask(file.id, revision.storageRevision, FileProcessingTaskType.TEXT_EXTRACTION);
      enqueued += 1;
    }
    const storageRoot = process.env.STORAGE_ROOT;
    const legacy = storageRoot && path.isAbsolute(storageRoot)
      ? await new LegacyFileBackfillService(
        this.database,
        new LocalFileStorage(storageRoot),
        this.tika,
        this.config,
      ).run({ cursor: options.cursor, limit, dryRun: options.dryRun })
      : { examined: 0, indexed: 0, failed: 0, nextCursor: null, skipped: true };
    const nextCursors = [files.length === limit ? files.at(-1)?.id ?? null : null, legacy.nextCursor]
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      examined: files.length + legacy.examined,
      enqueued,
      legacyIndexed: legacy.indexed,
      legacyFailed: legacy.failed,
      legacySkipped: legacy.skipped,
      providerNextCursor: files.length === limit ? files.at(-1)?.id ?? null : null,
      legacyNextCursor: legacy.nextCursor,
      // UUIDs from provider and legacy domains are interleaved. Returning the
      // lower cursor is resumable; duplicate task inserts remain idempotent.
      nextCursor: nextCursors[0] ?? null,
    };
  }

  private async tick(): Promise<void> {
    try {
      await this.runCycle();
    } catch (error) {
      this.logger.error({ event: 'file-processing-cycle-failed', error: this.errorCode(error) });
    } finally {
      if (!this.stopping) this.timer = setTimeout(() => void this.tick(), this.config.pollSeconds * 1000);
    }
  }

  private async processCycle(): Promise<number> {
    const scheduled = await this.consumeOutbox();
    const tasks = await this.claimTasks();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(this.config.concurrency, tasks.length) }, async () => {
      while (!this.stopping && next < tasks.length) await this.processTask(tasks[next++]);
    }));
    return scheduled + tasks.length;
  }

  private async consumeOutbox(): Promise<number> {
    const events = await this.database.outboxEvent.findMany({
      where: { eventType: 'FILE_CONTENT_CHANGED', status: OutboxStatus.PENDING },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: this.config.outboxBatchSize,
    });
    let consumed = 0;
    for (const event of events) {
      const didConsume = await this.database.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "OutboxEvent"
          WHERE "id" = ${event.id}::uuid AND "status" = ${OutboxStatus.PENDING}::"OutboxStatus"
          FOR UPDATE SKIP LOCKED
        `;
        if (!locked.length) return false;
        const outbox = await tx.outboxEvent.findUniqueOrThrow({
          where: { id: event.id }, select: { aggregateId: true },
        });
        if (!outbox.aggregateId) {
          await tx.outboxEvent.update({ where: { id: event.id }, data: { status: OutboxStatus.FAILED, lastError: 'MISSING_FILE_ID', attemptCount: { increment: 1 } } });
          return true;
        }
        const file = await tx.file.findUnique({
          where: { id: outbox.aggregateId },
          select: {
            id: true,
            revisionSequence: true,
            node: { select: { name: true, trashOperationId: true, file: { select: { driveFile: { select: { mimeType: true } } } } } },
          },
        });
        const mimeType = file?.node.file?.driveFile?.mimeType;
        if (!file || file.node.trashOperationId || !mimeType) {
          await tx.outboxEvent.update({ where: { id: event.id }, data: { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), lastError: null, attemptCount: { increment: 1 } } });
          return true;
        }
        const revision = await tx.fileRevision.findUnique({
          where: { fileId_sequence: { fileId: file.id, sequence: file.revisionSequence } },
          select: { storageRevision: true },
        });
        if (!revision) {
          await tx.outboxEvent.update({ where: { id: event.id }, data: { attemptCount: { increment: 1 }, lastError: 'CURRENT_REVISION_UNAVAILABLE' } });
          return true;
        }
        if (this.canExtract(mimeType, file.node.name)) {
          await tx.$executeRaw`
            INSERT INTO "FileProcessingTask" ("id", "fileId", "targetRevision", "type", "status", "availableAt", "createdAt")
            VALUES (${randomUUID()}::uuid, ${file.id}::uuid, ${revision.storageRevision}, ${FileProcessingTaskType.TEXT_EXTRACTION}::"FileProcessingTaskType", ${FileProcessingTaskStatus.PENDING}::"FileProcessingTaskStatus", NOW(), NOW())
            ON CONFLICT ("fileId", "targetRevision", "type") DO NOTHING
          `;
        }
        await tx.outboxEvent.update({ where: { id: event.id }, data: { status: OutboxStatus.PUBLISHED, publishedAt: new Date(), lastError: null, attemptCount: { increment: 1 } } });
        return true;
      });
      if (didConsume) consumed += 1;
    }
    return consumed;
  }

  private async enqueueTask(fileId: string, targetRevision: string, type: FileProcessingTaskType): Promise<void> {
    await this.database.$executeRaw`
      INSERT INTO "FileProcessingTask" ("id", "fileId", "targetRevision", "type", "status", "availableAt", "createdAt")
      VALUES (${randomUUID()}::uuid, ${fileId}::uuid, ${targetRevision}, ${type}::"FileProcessingTaskType", ${FileProcessingTaskStatus.PENDING}::"FileProcessingTaskStatus", NOW(), NOW())
      ON CONFLICT ("fileId", "targetRevision", "type") DO NOTHING
    `;
  }

  private async claimTasks(): Promise<ClaimedTask[]> {
    const lease = new Date(Date.now() + this.config.leaseSeconds * 1000);
    const leaseToken = crypto.randomUUID();
    return this.database.$transaction((tx) => tx.$queryRaw<ClaimedTask[]>`
      WITH candidates AS (
        SELECT "id" FROM "FileProcessingTask"
        WHERE "fileId" IS NOT NULL AND "targetRevision" IS NOT NULL
          AND "type" IN (${FileProcessingTaskType.TEXT_EXTRACTION}::"FileProcessingTaskType", ${FileProcessingTaskType.SEARCH_INDEX}::"FileProcessingTaskType")
          AND (("status" = ${FileProcessingTaskStatus.PENDING}::"FileProcessingTaskStatus" AND "availableAt" <= NOW())
            OR ("status" = ${FileProcessingTaskStatus.PROCESSING}::"FileProcessingTaskStatus" AND "leaseExpiresAt" <= NOW()))
        ORDER BY "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${this.config.batchSize}
      )
      UPDATE "FileProcessingTask" task
      SET "status" = ${FileProcessingTaskStatus.PROCESSING}::"FileProcessingTaskStatus",
          "attemptCount" = task."attemptCount" + 1,
          "startedAt" = NOW(), "leaseExpiresAt" = ${lease}, "leaseToken" = ${leaseToken}::uuid
      FROM candidates WHERE task."id" = candidates."id"
      RETURNING task."id", task."fileId", task."targetRevision", task."type", task."attemptCount", task."leaseToken"
    `);
  }

  private async processTask(task: ClaimedTask): Promise<void> {
    const startedAt = Date.now();
    try {
      if (task.type === FileProcessingTaskType.TEXT_EXTRACTION) await this.extract(task);
      else await this.index(task);
      this.logger.log({ event: 'file-processing-completed', taskId: task.id, fileId: task.fileId, taskType: task.type, targetRevision: task.targetRevision, attempt: task.attemptCount, durationMs: Date.now() - startedAt, stale: false });
    } catch (error) {
      if (error instanceof ProcessingError && error.code === 'STALE_REVISION') {
        await this.complete(task, 'STALE_REVISION');
        this.logger.log({ event: 'file-processing-stale', taskId: task.id, fileId: task.fileId, taskType: task.type, targetRevision: task.targetRevision, attempt: task.attemptCount, durationMs: Date.now() - startedAt, stale: true });
        return;
      }
      await this.fail(task, error);
    }
  }

  private async extract(task: ClaimedTask): Promise<void> {
    const file = await this.resolveCurrentFile(task);
    if (!file) throw new ProcessingError('STALE_REVISION', false);
    if (file.sizeBytes !== null && file.sizeBytes > BigInt(this.config.extractionMaxBytes)) {
      await this.publishExtraction(task, file, '', false, 'LIMIT_EXCEEDED');
      await this.complete(task, 'LIMIT_EXCEEDED');
      return;
    }
    const source = await this.reader.openVersion(file.objectId, file.providerVersionId);
    let result: { text: string; truncated: boolean };
    if (nativeExtractionSupported(file.mimeType, file.name)) {
      const bytes = await this.readBounded(source);
      result = extractNativeText(bytes, file.mimeType, file.name, this.config.extractionMaxChars);
    } else {
      const content = await this.tika.extractPlainText(source, file.mimeType);
      result = this.boundText(content);
    }
    await this.publishExtraction(task, file, result.text, result.truncated, null);
    await this.complete(task);
  }

  private async index(task: ClaimedTask): Promise<void> {
    const file = await this.resolveCurrentFile(task);
    if (!file) throw new ProcessingError('STALE_REVISION', false);
    const extraction = await this.database.fileTextExtraction.findUnique({
      where: { fileId_targetRevision: { fileId: task.fileId, targetRevision: task.targetRevision } },
      select: { contentText: true },
    });
    if (!extraction) throw new ProcessingError('EXTRACTOR_ERROR', true);
    await this.database.$transaction(async (tx) => {
      await this.requireOwnership(tx, task);
      const current = await this.currentRevision(tx, task.fileId);
      if (current !== task.targetRevision) throw new ProcessingError('STALE_REVISION', false);
      await tx.$executeRaw`
        INSERT INTO "SearchDocument" ("id", "fileId", "fileVersionId", "indexedRevision", "contentText", "searchVector", "indexedAt")
        VALUES (${randomUUID()}::uuid, ${task.fileId}::uuid, NULL, ${task.targetRevision}, ${extraction.contentText}, to_tsvector('simple', public.search_unaccent(${extraction.contentText})), NOW())
        ON CONFLICT ("fileId") DO UPDATE SET
          "fileVersionId" = NULL, "indexedRevision" = EXCLUDED."indexedRevision",
          "contentText" = EXCLUDED."contentText", "searchVector" = EXCLUDED."searchVector", "indexedAt" = EXCLUDED."indexedAt"
      `;
    });
    await this.complete(task);
  }

  private async publishExtraction(task: ClaimedTask, file: ProcessingFile, contentText: string, truncated: boolean, errorCode: string | null): Promise<void> {
    await this.database.$transaction(async (tx) => {
      await this.requireOwnership(tx, task);
      const current = await this.currentRevision(tx, task.fileId);
      if (current !== task.targetRevision) throw new ProcessingError('STALE_REVISION', false);
      await tx.fileTextExtraction.upsert({
        where: { fileId_targetRevision: { fileId: task.fileId, targetRevision: task.targetRevision } },
        update: { contentText, truncated, errorCode },
        create: { fileId: task.fileId, targetRevision: task.targetRevision, contentText, truncated, errorCode },
      });
      await tx.$executeRaw`
        INSERT INTO "FileProcessingTask" ("id", "fileId", "targetRevision", "type", "status", "availableAt", "createdAt")
        VALUES (${randomUUID()}::uuid, ${file.fileId}::uuid, ${file.targetRevision}, ${FileProcessingTaskType.SEARCH_INDEX}::"FileProcessingTaskType", ${FileProcessingTaskStatus.PENDING}::"FileProcessingTaskStatus", NOW(), NOW())
        ON CONFLICT ("fileId", "targetRevision", "type") DO NOTHING
      `;
    });
  }

  private async resolveCurrentFile(task: ClaimedTask): Promise<ProcessingFile | null> {
    const file = await this.database.file.findUnique({
      where: { id: task.fileId },
      select: {
        id: true,
        revisionSequence: true,
        node: { select: { id: true, name: true, trashOperationId: true } },
        driveFile: { select: { driveFileId: true, mimeType: true, sizeBytes: true, sourceStatus: true } },
      },
    });
    if (!file || file.node.trashOperationId || !file.driveFile || file.driveFile.sourceStatus === 'UNAVAILABLE') return null;
    const revision = await this.database.fileRevision.findUnique({
      where: { fileId_sequence: { fileId: file.id, sequence: file.revisionSequence } },
      select: { providerVersionId: true, storageRevision: true, sizeBytes: true },
    });
    if (!revision || revision.storageRevision !== task.targetRevision) return null;
    return {
      fileId: file.id,
      nodeId: file.node.id,
      name: file.node.name,
      mimeType: file.driveFile.mimeType,
      sizeBytes: revision.sizeBytes ?? file.driveFile.sizeBytes,
      objectId: file.driveFile.driveFileId,
      providerVersionId: revision.providerVersionId,
      targetRevision: revision.storageRevision,
    };
  }

  private async currentRevision(tx: Prisma.TransactionClient, fileId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<{ storageRevision: string }[]>`
      SELECT revision."storageRevision"
      FROM "File" file
      INNER JOIN "FileRevision" revision
        ON revision."fileId" = file."id" AND revision."sequence" = file."revisionSequence"
      WHERE file."id" = ${fileId}::uuid
      FOR UPDATE OF file
    `;
    return rows[0]?.storageRevision ?? null;
  }

  private async requireOwnership(tx: Prisma.TransactionClient, task: ClaimedTask): Promise<void> {
    const owners = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "FileProcessingTask"
      WHERE "id" = ${task.id}::uuid
        AND "status" = ${FileProcessingTaskStatus.PROCESSING}::"FileProcessingTaskStatus"
        AND "leaseToken" = ${task.leaseToken}::uuid
        AND "leaseExpiresAt" > NOW()
      FOR UPDATE
    `;
    if (!owners.length) throw new ProcessingError('STALE_REVISION', false);
  }

  private async complete(task: ClaimedTask, code: string | null = null): Promise<void> {
    await this.database.fileProcessingTask.updateMany({
      where: { id: task.id, status: FileProcessingTaskStatus.PROCESSING, leaseToken: task.leaseToken, leaseExpiresAt: { gt: new Date() } },
      data: { status: FileProcessingTaskStatus.COMPLETED, completedAt: new Date(), leaseExpiresAt: null, leaseToken: null, lastError: code },
    });
  }

  private async fail(task: ClaimedTask, error: unknown): Promise<void> {
    const classified = this.classify(error);
    const retry = classified.retryable && task.attemptCount < this.config.maxAttempts;
    const delaySeconds = Math.min(60 * 2 ** Math.max(0, task.attemptCount - 1), 900);
    const result = await this.database.fileProcessingTask.updateMany({
      where: { id: task.id, status: FileProcessingTaskStatus.PROCESSING, leaseToken: task.leaseToken, leaseExpiresAt: { gt: new Date() } },
      data: retry
        ? { status: FileProcessingTaskStatus.PENDING, availableAt: new Date(Date.now() + delaySeconds * 1000), leaseExpiresAt: null, leaseToken: null, lastError: classified.code }
        : { status: FileProcessingTaskStatus.FAILED, leaseExpiresAt: null, leaseToken: null, lastError: classified.code },
    });
    if (result.count) this.logger.warn({ event: 'file-processing-failed', taskId: task.id, fileId: task.fileId, taskType: task.type, targetRevision: task.targetRevision, attempt: task.attemptCount, result: retry ? 'RETRY' : 'FAILED', error: classified.code });
  }

  private canExtract(mimeType: string, name: string): boolean {
    if (mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return false;
    return nativeExtractionSupported(mimeType, name)
      || mimeType === 'application/pdf'
      || name.toLowerCase().endsWith('.pdf')
      || ['.doc', '.xls', '.ppt'].some((suffix) => name.toLowerCase().endsWith(suffix));
  }

  private async readBounded(source: import('node:stream').Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > this.config.extractionMaxBytes) {
        source.destroy();
        throw new ProcessingError('LIMIT_EXCEEDED', false);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  private boundText(content: string) {
    const text = content.replace(/\r\n/g, '\n').trim();
    return text.length <= this.config.extractionMaxChars
      ? { text, truncated: false }
      : { text: text.slice(0, this.config.extractionMaxChars), truncated: true };
  }

  private classify(error: unknown): ProcessingError {
    if (error instanceof ProcessingError) return error;
    if (error instanceof NativeExtractionError) return new ProcessingError(error.code, false, { cause: error });
    if (error instanceof RevisionContentReaderError) return new ProcessingError(error.retryable ? 'TRANSIENT_STORAGE_ERROR' : 'EXTRACTOR_ERROR', error.retryable, { cause: error });
    if (error instanceof TikaClientError) return new ProcessingError(error.message.includes('timed out') ? 'TIMEOUT' : 'EXTRACTOR_ERROR', error.retryable, { cause: error });
    return new ProcessingError('EXTRACTOR_ERROR', true, { cause: error });
  }

  private errorCode(error: unknown): string {
    return this.classify(error).code;
  }
}
