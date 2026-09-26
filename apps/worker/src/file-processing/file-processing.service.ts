import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  FileProcessingTaskStatus,
  FileProcessingTaskType,
  isSearchableFileMimeType,
  type PrismaClient,
} from '@dochub/database';
import type { StorageService } from '@dochub/storage';
import { TikaClient, TikaClientError } from '../tika/tika.client.js';
import type { FileProcessingConfig } from './file-processing.config.js';

type ClaimedTask = { id: string; fileVersionId: string; attemptCount: number };

/** Bounded, leased text-extraction worker. Search API consumption is intentionally absent. */
export class FileProcessingService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(FileProcessingService.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopping = false;
  private backfillCursor: string | undefined;
  private reindexCursor: string | undefined;
  private reindexComplete = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: StorageService,
    private readonly tika: TikaClient,
    private readonly config: FileProcessingConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log('File processing started');
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
    this.logger.log('File processing stopped');
  }

  runCycle(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processCycle().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async backfillCurrentVersions(): Promise<number> {
    const files = await this.database.file.findMany({
      where: {
        currentVersionId: { not: null },
        ...(this.backfillCursor ? { id: { gt: this.backfillCursor } } : {}),
      },
      select: {
        id: true,
        currentVersion: { select: { id: true, mimeType: true } },
      },
      orderBy: { id: 'asc' },
      take: this.config.batchSize,
    });
    if (!files.length) {
      this.backfillCursor = undefined;
      return 0;
    }
    this.backfillCursor = files.at(-1)?.id;
    const data = files.flatMap((file) =>
      file.currentVersion &&
      isSearchableFileMimeType(file.currentVersion.mimeType)
        ? [
            {
              fileVersionId: file.currentVersion.id,
              type: FileProcessingTaskType.TEXT_EXTRACTION,
            },
          ]
        : [],
    );
    if (data.length)
      await this.database.fileProcessingTask.createMany({
        data,
        skipDuplicates: true,
      });
    return data.length;
  }

  private async tick(): Promise<void> {
    try {
      await this.runCycle();
    } catch {
      this.logger.error('File-processing cycle failed; retrying next cycle');
    } finally {
      if (!this.stopping)
        this.timer = setTimeout(
          () => void this.tick(),
          this.config.pollSeconds * 1000,
        );
    }
  }

  private async processCycle(): Promise<number> {
    if (!this.reindexComplete) await this.reindexCurrentSearchDocuments();
    await this.backfillCurrentVersions();
    const tasks = await this.claimTasks();
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(this.config.concurrency, tasks.length) },
        async () => {
          while (!this.stopping && next < tasks.length)
            await this.processTask(tasks[next++]);
        },
      ),
    );
    return tasks.length;
  }

  /** Bounded compatibility pass for rows written before accent-folded vectors. */
  private async reindexCurrentSearchDocuments(): Promise<void> {
    const documents = await this.database.searchDocument.findMany({
      where: this.reindexCursor
        ? { id: { gt: this.reindexCursor } }
        : undefined,
      select: { id: true },
      orderBy: { id: 'asc' },
      take: this.config.batchSize,
    });
    if (!documents.length) {
      this.reindexCursor = undefined;
      this.reindexComplete = true;
      return;
    }
    this.reindexCursor = documents.at(-1)?.id;
    for (const document of documents)
      await this.database.$executeRaw`
        UPDATE "SearchDocument" AS sd
        SET "searchVector" = to_tsvector('simple', public.search_unaccent(sd."contentText")),
            "indexedAt" = NOW()
        FROM "File" AS f
        WHERE sd."id" = ${document.id}::uuid
          AND f."id" = sd."fileId"
          AND f."currentVersionId" = sd."fileVersionId"
          AND sd."searchVector" IS DISTINCT FROM to_tsvector('simple', public.search_unaccent(sd."contentText"))
      `;
  }

  private async claimTasks(): Promise<ClaimedTask[]> {
    const lease = new Date(Date.now() + this.config.leaseSeconds * 1000);
    return this.database.$transaction(
      (tx) =>
        tx.$queryRaw<ClaimedTask[]>`
        WITH candidates AS (
          SELECT "id" FROM "FileProcessingTask"
          WHERE "type" = ${FileProcessingTaskType.TEXT_EXTRACTION}::"FileProcessingTaskType"
            AND (("status" = ${FileProcessingTaskStatus.PENDING}::"FileProcessingTaskStatus" AND "availableAt" <= NOW())
              OR ("status" = ${FileProcessingTaskStatus.PROCESSING}::"FileProcessingTaskStatus" AND "leaseExpiresAt" <= NOW()))
          ORDER BY "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.config.batchSize}
        )
        UPDATE "FileProcessingTask" task
        SET "status" = ${FileProcessingTaskStatus.PROCESSING}::"FileProcessingTaskStatus",
            "attemptCount" = task."attemptCount" + 1,
            "startedAt" = NOW(), "leaseExpiresAt" = ${lease}
        FROM candidates WHERE task."id" = candidates."id"
        RETURNING task."id", task."fileVersionId", task."attemptCount"
      `,
    );
  }

  private async processTask(task: ClaimedTask): Promise<void> {
    try {
      const version = await this.database.fileVersion.findUnique({
        where: { id: task.fileVersionId },
        select: {
          id: true,
          fileId: true,
          storageKey: true,
          mimeType: true,
          file: { select: { currentVersionId: true } },
        },
      });
      if (
        !version ||
        version.file.currentVersionId !== version.id ||
        !isSearchableFileMimeType(version.mimeType)
      ) {
        await this.complete(task.id);
        return;
      }
      const source = await this.storage.openReadStream(version.storageKey);
      const content = await this.tika.extractPlainText(
        source,
        version.mimeType,
      );
      await this.writeCurrentDocument(version.fileId, version.id, content);
      await this.complete(task.id);
    } catch (error) {
      await this.fail(task, error);
    }
  }

  private async writeCurrentDocument(
    fileId: string,
    versionId: string,
    content: string,
  ): Promise<void> {
    await this.database.$transaction(async (tx) => {
      const files = await tx.$queryRaw<{ currentVersionId: string | null }[]>`
        SELECT "currentVersionId" FROM "File" WHERE "id" = ${fileId}::uuid FOR UPDATE
      `;
      if (files[0]?.currentVersionId !== versionId) return;
      await tx.$executeRaw`
        INSERT INTO "SearchDocument" ("id", "fileId", "fileVersionId", "contentText", "searchVector", "indexedAt")
        VALUES (${crypto.randomUUID()}::uuid, ${fileId}::uuid, ${versionId}::uuid, ${content}, to_tsvector('simple', public.search_unaccent(${content})), NOW())
        ON CONFLICT ("fileId") DO UPDATE SET
          "fileVersionId" = EXCLUDED."fileVersionId", "contentText" = EXCLUDED."contentText",
          "searchVector" = EXCLUDED."searchVector", "indexedAt" = EXCLUDED."indexedAt"
      `;
    });
  }

  private async complete(taskId: string): Promise<void> {
    await this.database.fileProcessingTask.updateMany({
      where: { id: taskId, status: FileProcessingTaskStatus.PROCESSING },
      data: {
        status: FileProcessingTaskStatus.COMPLETED,
        completedAt: new Date(),
        leaseExpiresAt: null,
        lastError: null,
      },
    });
  }

  private async fail(task: ClaimedTask, error: unknown): Promise<void> {
    const retryable = !(error instanceof TikaClientError) || error.retryable;
    const retry = retryable && task.attemptCount < this.config.maxAttempts;
    const delaySeconds = Math.min(
      60 * 2 ** Math.max(0, task.attemptCount - 1),
      900,
    );
    await this.database.fileProcessingTask.updateMany({
      where: { id: task.id, status: FileProcessingTaskStatus.PROCESSING },
      data: retry
        ? {
            status: FileProcessingTaskStatus.PENDING,
            availableAt: new Date(Date.now() + delaySeconds * 1000),
            leaseExpiresAt: null,
            lastError: this.errorCategory(error),
          }
        : {
            status: FileProcessingTaskStatus.FAILED,
            leaseExpiresAt: null,
            lastError: this.errorCategory(error),
          },
    });
    this.logger.warn(
      `File processing ${task.id}: ${this.errorCategory(error)}`,
    );
  }

  private errorCategory(error: unknown): string {
    if (error instanceof TikaClientError)
      return error.retryable ? 'TIKA_RETRYABLE' : 'TIKA_REJECTED';
    return 'STORAGE_OR_PROCESSING_ERROR';
  }
}
