import { Logger } from '@nestjs/common';
import { TrashPurgeEngine } from '@dochub/trash';
import { RetentionService } from '../src/retention/retention.service.js';
import { createRetentionFixture } from './retention-fixture.js';

describe('retention with PostgreSQL and isolated LocalFileStorage', () => {
  let fixture: Awaited<ReturnType<typeof createRetentionFixture>>;
  const services: RetentionService[] = [];
  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    fixture = await createRetentionFixture();
  });
  afterEach(async () => {
    for (const service of services.splice(0)) await service.onModuleDestroy();
    vi.restoreAllMocks();
    await fixture?.cleanup();
  });
  function service(batchSize = 20) {
    const instance = new RetentionService(
      fixture.scoped,
      new TrashPurgeEngine(fixture.database, fixture.storage),
      { pollSeconds: 60, batchSize, operationConcurrency: 1 },
    );
    services.push(instance);
    return instance;
  }
  async function status(id: string) {
    return (
      await fixture.database.trashOperation.findUniqueOrThrow({ where: { id } })
    ).status;
  }
  async function assertPurged(
    doc: Awaited<ReturnType<typeof fixture.document>>,
  ) {
    expect(await fixture.storage.exists(doc.storageKey)).toBe(false);
    expect(
      await fixture.database.node.findUnique({ where: { id: doc.node.id } }),
    ).toBeNull();
    expect(
      await fixture.database.file.findUnique({ where: { id: doc.file.id } }),
    ).toBeNull();
    expect(
      await fixture.database.fileVersion.findUnique({
        where: { id: doc.version.id },
      }),
    ).toBeNull();
    const operation = await fixture.database.trashOperation.findUniqueOrThrow({
      where: { id: doc.operation.id },
    });
    expect(operation).toMatchObject({
      status: 'PURGED',
      rootNodeId: null,
      purgedAt: expect.any(Date),
    });
    const audits = await fixture.database.auditLog.findMany({
      where: { action: 'NODE_PURGED', resourceId: doc.node.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      result: 'SUCCESS',
    });
  }
  async function assertIntact(
    doc: Awaited<ReturnType<typeof fixture.document>>,
  ) {
    expect(await fixture.storage.exists(doc.storageKey)).toBe(true);
    expect(
      await fixture.database.node.findUnique({ where: { id: doc.node.id } }),
    ).not.toBeNull();
    expect(
      await fixture.database.file.findUnique({ where: { id: doc.file.id } }),
    ).not.toBeNull();
    expect(
      await fixture.database.fileVersion.findUnique({
        where: { id: doc.version.id },
      }),
    ).not.toBeNull();
    expect(
      await fixture.database.auditLog.count({
        where: { action: 'NODE_PURGED', resourceId: doc.node.id },
      }),
    ).toBe(0);
  }
  it('purges expired ACTIVE through PURGING with no user DELETE ACL and one SYSTEM audit', async () => {
    const doc = await fixture.document('ACTIVE', new Date());
    await assertIntact(doc);
    expect(
      await fixture.database.permissionEntry.count({
        where: { nodeId: doc.node.id },
      }),
    ).toBe(0);
    expect(doc.node).toMatchObject({
      parentId: null,
      inheritPermissions: false,
      publicAccess: false,
    });
    const originalDelete = fixture.storage.delete.bind(fixture.storage);
    const deletion = vi
      .spyOn(fixture.storage, 'delete')
      .mockImplementation(async (key) => {
        expect(await status(doc.operation.id)).toBe('PURGING');
        await assertIntact(doc);
        await originalDelete(key);
      });
    expect(await service().runCycle()).toBe(1);
    expect(deletion).toHaveBeenCalledOnce();
    await assertPurged(doc);
  });
  it.each(['ACTIVE', 'RESTORED', 'PURGED'] as const)(
    'excludes %s (future ACTIVE or old terminal operation)',
    async (state) => {
      const doc = await fixture.document(
        state,
        new Date(Date.now() + (state === 'ACTIVE' ? 60_000 : -60_000)),
      );
      expect(await service().runCycle()).toBe(0);
      expect(await status(doc.operation.id)).toBe(state);
      await assertIntact(doc);
    },
  );
  it('keeps metadata and no success audit after storage failure, then recovers PURGING even with future expiry', async () => {
    const doc = await fixture.document();
    const deletion = vi
      .spyOn(fixture.storage, 'delete')
      .mockRejectedValueOnce(new Error('controlled storage failure'));
    const worker = service();
    expect(await worker.runCycle()).toBe(1);
    expect(await status(doc.operation.id)).toBe('PURGING');
    await assertIntact(doc);
    await fixture.database.trashOperation.update({
      where: { id: doc.operation.id },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    deletion.mockRestore();
    expect(await worker.runCycle()).toBe(1);
    await assertPurged(doc);
  });
  it('a repeatedly failing PURGING does not starve expired ACTIVE at batch size 1', async () => {
    const failing = await fixture.document(
      'PURGING',
      undefined,
      '00000000-0000-4000-8000-000000000001',
    );
    const active = await fixture.document(
      'ACTIVE',
      undefined,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    );
    const originalDelete = fixture.storage.delete.bind(fixture.storage);
    vi.spyOn(fixture.storage, 'delete').mockImplementation(async (key) => {
      if (key === failing.storageKey)
        throw new Error('persistent controlled failure');
      await originalDelete(key);
    });
    const worker = service(1);
    expect(await worker.runCycle()).toBe(1);
    await assertIntact(failing);
    expect(await worker.runCycle()).toBe(1);
    await assertPurged(active);
    expect(await worker.runCycle()).toBe(1);
    expect(await status(failing.operation.id)).toBe('PURGING');
    await assertIntact(failing);
  });
  it('processes no more than the batch limit and leaves remaining work for later cycles', async () => {
    const docs = [];
    for (let index = 0; index < 5; index += 1)
      docs.push(await fixture.document());
    const worker = service(2);
    expect(await worker.runCycle()).toBe(2);
    expect(
      await fixture.database.trashOperation.count({
        where: { trashedById: fixture.actorId, status: 'PURGED' },
      }),
    ).toBe(2);
    expect(await worker.runCycle()).toBe(2);
    expect(await worker.runCycle()).toBe(1);
    for (const doc of docs) await assertPurged(doc);
  });
  it('two workers delete at least once and produce exactly one structural audit', async () => {
    const doc = await fixture.document();
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalDelete = fixture.storage.delete.bind(fixture.storage);
    vi.spyOn(fixture.storage, 'delete').mockImplementation(async (key) => {
      if (++arrivals === 2) release();
      await barrier;
      await originalDelete(key);
    });
    // Barrier forces both claims/storage attempts before either finalization.
    expect(
      await Promise.all([service().runCycle(), service().runCycle()]),
    ).toEqual([1, 1]);
    expect(arrivals).toBe(2);
    await assertPurged(doc);
  });
});
