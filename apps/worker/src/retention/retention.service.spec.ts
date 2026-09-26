import { Logger } from '@nestjs/common';
import { type PrismaClient, type Prisma } from '@dochub/database';
import { type TrashPurgeEngine } from '@dochub/trash';
import { RetentionService, retentionEligibility } from './retention.service.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  ids = ['a', 'b', 'c'],
  batchSize = 20,
  operationConcurrency = 1,
) {
  const findMany = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
  const database = { trashOperation: { findMany } } as unknown as PrismaClient;
  const purge = vi
    .fn<TrashPurgeEngine['purge']>()
    .mockResolvedValue({} as never);
  const service = new RetentionService(
    database,
    { purge },
    { pollSeconds: 1, batchSize, operationConcurrency },
  );
  return { service, purge, findMany };
}

describe('retention scheduling and policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('selects expired ACTIVE (inclusive) and any PURGING, excluding terminal and future ACTIVE', () => {
    const now = new Date();
    expect(retentionEligibility(now)).toEqual({
      OR: [
        { status: 'ACTIVE', expiresAt: { lte: now } },
        { status: 'PURGING' },
      ],
    });
  });

  it('uses SYSTEM/null and rechecks eligibility under the engine transaction lock', async () => {
    const { service, purge } = fixture(['a']);
    await service.runCycle();
    const request = purge.mock.calls[0][0];
    expect(request.actor).toEqual({ actorType: 'SYSTEM', actorId: null });
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockResolvedValueOnce(null);
    const tx = {
      trashOperation: { findFirst },
    } as unknown as Prisma.TransactionClient;
    expect(await request.authorize('root', tx)).toBe('allowed');
    expect(await request.authorize('root', tx)).toBe('forbidden');
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'a',
      ...retentionEligibility(new Date()),
    });
  });

  it('rotates past failed work, wraps once, and limits the combined batch', async () => {
    const { service, purge, findMany } = fixture([], 2);
    findMany
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValueOnce([{ id: 'c' }])
      .mockResolvedValueOnce([{ id: 'a' }]);
    purge.mockRejectedValue(new Error('controlled failure'));
    expect(await service.runCycle()).toBe(2);
    expect(await service.runCycle()).toBe(2);
    expect(purge.mock.calls.map(([request]) => request.operationId)).toEqual([
      'a',
      'b',
      'c',
      'a',
    ]);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      take: 2,
      orderBy: { id: 'asc' },
    });
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { id: { gt: 'b' } },
      take: 2,
    });
    expect(findMany.mock.calls[2][0]).toMatchObject({
      where: { id: { lte: 'b' } },
      take: 1,
    });
  });

  it('bounds operation concurrency while draining only the selected batch', async () => {
    const { service, purge } = fixture(['a', 'b', 'c', 'd', 'e'], 5, 2);
    const gates = Array.from({ length: 5 }, deferred);
    let active = 0;
    let maximum = 0;
    let started = 0;
    purge.mockImplementation(async () => {
      const gate = gates[started++];
      maximum = Math.max(maximum, ++active);
      await gate.promise;
      active -= 1;
      return {} as never;
    });
    const cycle = service.runCycle();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    gates[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(3);
    for (const gate of gates) gate.resolve();
    expect(await cycle).toBe(5);
    expect(maximum).toBe(2);
  });

  it('runs immediately and never overlaps a long cycle despite polling time passing', async () => {
    const { service, purge, findMany } = fixture(['a'], 1);
    const gate = deferred();
    purge.mockImplementationOnce(async () => {
      await gate.promise;
      return {} as never;
    });
    expect(service.onApplicationBootstrap()).toBeUndefined();
    const startup = service.runCycle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(findMany).toHaveBeenCalledTimes(1);
    const first = service.runCycle();
    expect(service.runCycle()).toBe(first);
    expect(purge).toHaveBeenCalledTimes(1);
    gate.resolve();
    await startup;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(purge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(purge).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('clears the pending timer and never schedules or runs after shutdown', async () => {
    const { service, findMany } = fixture([]);
    service.onApplicationBootstrap();
    await service.runCycle();
    expect(vi.getTimerCount()).toBe(1);
    await service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await service.runCycle()).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('waits for current work but starts no queued operation during shutdown', async () => {
    const { service, purge } = fixture();
    const gate = deferred();
    purge.mockImplementation(async () => {
      await gate.promise;
      return {} as never;
    });
    service.onApplicationBootstrap();
    const startup = service.runCycle();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(false);
    expect(purge).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.all([startup, stop]);
    expect(stopped).toBe(true);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no operation when shutdown happens during candidate selection', async () => {
    const { service, purge, findMany } = fixture();
    const gate = deferred();
    findMany.mockImplementation(async () => {
      await gate.promise;
      return [{ id: 'a' }];
    });
    const cycle = service.runCycle();
    const stop = service.onModuleDestroy();
    gate.resolve();
    expect(await cycle).toBe(0);
    await stop;
    expect(purge).not.toHaveBeenCalled();
  });

  it('schedules recovery after a database selection failure', async () => {
    const { service, findMany } = fixture([]);
    findMany.mockRejectedValueOnce(new Error('controlled database failure'));
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(findMany).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('finishes shutdown when the current candidate query rejects', async () => {
    const { service, findMany } = fixture([]);
    const gate = deferred();
    findMany.mockImplementation(async () => {
      await gate.promise;
      throw new Error('controlled database failure during shutdown');
    });
    service.onApplicationBootstrap();
    const stop = service.onModuleDestroy();
    gate.resolve();
    await expect(stop).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
