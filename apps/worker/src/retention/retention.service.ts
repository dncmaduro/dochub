import {
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  AuditActorType,
  type Prisma,
  type PrismaClient,
} from '@dochub/database';
import { PurgeError, type TrashPurgeEngine } from '@dochub/trash';
import type { RetentionConfig } from './retention.config.js';

export function retentionEligibility(
  now: Date,
): Prisma.TrashOperationWhereInput {
  return {
    OR: [{ status: 'ACTIVE', expiresAt: { lte: now } }, { status: 'PURGING' }],
  };
}

export class RetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RetentionService.name);
  private cursor: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<number> | undefined;
  private stopping = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly engine: Pick<TrashPurgeEngine, 'purge'>,
    private readonly config: RetentionConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log('Trash retention started');
    // Let bootstrap finish and install signal handlers while the first cycle runs.
    void this.tick();
  }

  // This hook finishes before DatabaseService.onApplicationShutdown disconnects.
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    // tick() logs selection errors; a failed cycle must not prevent DB shutdown.
    await this.inFlight?.catch(() => undefined);
    this.logger.log('Trash retention stopped');
  }

  runCycle(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.processBatch().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async tick(): Promise<void> {
    try {
      const processed = await this.runCycle();
      this.logger.log(
        `Trash retention cycle settled: ${processed} operation(s) attempted`,
      );
    } catch {
      this.logger.error(
        'Trash retention candidate query failed; retrying next cycle',
      );
    } finally {
      if (!this.stopping) {
        this.timer = setTimeout(() => {
          void this.tick();
        }, this.config.pollSeconds * 1000);
      }
    }
  }

  private async selectCandidates() {
    const eligible = retentionEligibility(new Date());
    const candidates = await this.database.trashOperation.findMany({
      where: {
        ...eligible,
        ...(this.cursor ? { id: { gt: this.cursor } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: this.config.batchSize,
    });
    if (this.cursor && candidates.length < this.config.batchSize) {
      candidates.push(
        ...(await this.database.trashOperation.findMany({
          where: { ...eligible, id: { lte: this.cursor } },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: this.config.batchSize - candidates.length,
        })),
      );
    }
    return candidates;
  }

  private async processBatch(): Promise<number> {
    const candidates = await this.selectCandidates();
    let next = 0;
    let attempted = 0;
    // Fixed-size pool; never one promise per candidate in an unbounded query.
    await Promise.all(
      Array.from(
        {
          length: Math.min(this.config.operationConcurrency, candidates.length),
        },
        async () => {
          while (!this.stopping && next < candidates.length) {
            const candidate = candidates[next++];
            this.cursor = candidate.id;
            attempted += 1;
            try {
              await this.engine.purge({
                operationId: candidate.id,
                actor: { actorType: AuditActorType.SYSTEM, actorId: null },
                // The engine holds the operation lock here. Recheck eligibility
                // against races with restore/expiry edits, without any user ACL.
                authorize: async (_rootNodeId, tx) => {
                  const eligible = await tx.trashOperation.findFirst({
                    where: {
                      id: candidate.id,
                      ...retentionEligibility(new Date()),
                    },
                    select: { id: true },
                  });
                  return eligible ? 'allowed' : 'forbidden';
                },
              });
            } catch (error) {
              const reason =
                error instanceof PurgeError ? error.code : 'UNEXPECTED';
              this.logger.warn(
                `Trash retention ${candidate.id}: ${reason}; continuing`,
              );
            }
          }
        },
      ),
    );
    return attempted;
  }
}
