import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { FileSaveOperationStatus, finalizeFileMutationOperation, type PrismaClient } from '@dochub/database';
import type { FileMutationReconciliationConfig } from './file-mutation-reconciliation.config.js';

export function mutationReconciliationEligibility(now: Date, staleSeconds: number) {
  return {
    status: FileSaveOperationStatus.PROVIDER_WRITTEN,
    updatedAt: { lte: new Date(now.getTime() - staleSeconds * 1000) },
  };
}

export function unrecoverableMutationFinalization(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return error.message.includes('has no durable provider result')
    || error.message.includes('missing its baseline version')
    || (typeof code === 'string' && ['P2002', 'P2025'].includes(code));
}

/** DB-only crash recovery for mutations that already crossed the provider-write boundary. */
export class FileMutationReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FileMutationReconciliationService.name);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopping = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly config: FileMutationReconciliationConfig,
  ) {}

  onApplicationBootstrap() {
    this.logger.log('File mutation reconciliation started');
    void this.tick();
  }

  async onModuleDestroy() {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.inFlight?.catch(() => undefined);
    this.logger.log('File mutation reconciliation stopped');
  }

  runCycle(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processBatch().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async tick() {
    try {
      const processed = await this.runCycle();
      this.logger.log({ event: 'file-mutation-reconciliation-cycle', processed });
    } catch (error) {
      this.logger.error({ event: 'file-mutation-reconciliation-cycle-failed', error: error instanceof Error ? error.name : 'UNKNOWN' });
    } finally {
      if (!this.stopping) this.timer = setTimeout(() => { void this.tick(); }, this.config.pollSeconds * 1000);
    }
  }

  private async processBatch(): Promise<number> {
    const candidates = await this.database.fileSaveOperation.findMany({
      where: {
        updatedAt: mutationReconciliationEligibility(new Date(), this.config.staleSeconds).updatedAt,
        status: { in: [FileSaveOperationStatus.PENDING, FileSaveOperationStatus.PROVIDER_WRITTEN] },
      },
      select: { operationId: true, fileId: true, operationType: true, status: true, createdAt: true, finalizationAttempts: true },
      orderBy: { updatedAt: 'asc' },
      take: this.config.batchSize,
    });
    for (const candidate of candidates) {
      if (candidate.status === FileSaveOperationStatus.PENDING) {
        this.logger.warn({ event: 'file-mutation-pending-review', operationId: candidate.operationId, fileId: candidate.fileId, operationType: candidate.operationType, state: candidate.status, ageSeconds: Math.floor((Date.now() - candidate.createdAt.getTime()) / 1000) });
        continue;
      }
      try {
        await finalizeFileMutationOperation(this.database, candidate.operationId);
        this.logger.log({ event: 'file-mutation-reconciled', operationId: candidate.operationId, fileId: candidate.fileId, operationType: candidate.operationType });
      } catch (error) {
        const category = error instanceof Error ? error.name : 'UNKNOWN';
        const failed = unrecoverableMutationFinalization(error);
        await this.database.fileSaveOperation.update({ where: { operationId: candidate.operationId }, data: { ...(failed ? { status: FileSaveOperationStatus.FAILED, failureReason: category } : {}), finalizationAttempts: { increment: 1 }, lastFinalizationError: category } }).catch(() => undefined);
        this.logger.error({ event: failed ? 'file-mutation-reconciliation-unrecoverable' : 'file-mutation-reconciliation-failed', operationId: candidate.operationId, fileId: candidate.fileId, operationType: candidate.operationType, state: failed ? FileSaveOperationStatus.FAILED : FileSaveOperationStatus.PROVIDER_WRITTEN, attemptCount: candidate.finalizationAttempts + 1, ageSeconds: Math.floor((Date.now() - candidate.createdAt.getTime()) / 1000), error: category });
      }
    }
    return candidates.length;
  }
}
