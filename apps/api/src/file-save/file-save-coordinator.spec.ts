import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { FileSaveCoordinator } from './file-save-coordinator.js';

function harness(revisions: string[] = ['R1', 'R2', 'R3'], replaceRevisions: string[] = ['R2']) {
  const reference = { provider: 'GOOGLE_DRIVE' as const, objectId: 'drive-file' };
  const engine = {
    id: 'DOCUMENT',
    prepareSave: vi.fn().mockResolvedValue({ stream: Readable.from([Buffer.from('saved')]), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    openModel: vi.fn().mockImplementation(async (_file: unknown, context: { storageRevision?: string }) => ({ storageRevision: context.storageRevision })),
  };
  const operations = new Map<string, Record<string, unknown>>();
  let sequence = 1;
  const transaction = {
    file: {
      update: vi.fn().mockImplementation(async () => ({ revisionSequence: ++sequence })),
    },
    fileRevision: { count: vi.fn().mockResolvedValue(1), findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockImplementation(async (input: { data: Record<string, unknown> }) => ({ id: 'revision', sequence: input.data.sequence })) },
    fileSaveOperation: {
      findUniqueOrThrow: vi.fn().mockImplementation(async ({ where }: { where: { operationId: string } }) => ({ ...operations.get(where.operationId), file: { id: 'file', nodeId: 'node', driveFileId: 'drive-record' } })),
      update: vi.fn().mockImplementation(async ({ where, data }: { where: { operationId: string }, data: Record<string, unknown> }) => {
        const prior = operations.get(where.operationId) ?? {};
        operations.set(where.operationId, { ...prior, ...data });
      }),
    },
    driveFile: { update: vi.fn() },
    node: { update: vi.fn() },
    auditLog: { upsert: vi.fn() },
    outboxEvent: { upsert: vi.fn() },
  };
  const database = {
    prisma: {
      fileSaveOperation: {
        findUnique: vi.fn().mockImplementation(async ({ where }: { where: { operationId: string } }) => operations.get(where.operationId) ?? null),
        findUniqueOrThrow: vi.fn().mockImplementation(async ({ where }: { where: { operationId: string } }) => operations.get(where.operationId) ?? null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { operations.set(data.operationId as string, { ...data, status: 'PENDING' }); }),
        update: vi.fn().mockImplementation(async ({ where, data }: { where: { operationId: string }, data: Record<string, unknown> }) => { const current = operations.get(where.operationId) ?? {}; Object.assign(current, data); operations.set(where.operationId, current); }),
      },
      node: { findFirst: vi.fn().mockResolvedValue({ id: 'node', name: 'report.docx', parentId: null, file: { id: 'file', backingType: 'GOOGLE_DRIVE', driveFile: { id: 'drive-record', driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5n, trashed: false, sourceStatus: 'CONNECTED' } } }) },
      fileRevision: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) => callback(transaction)),
    },
  };
  const storage = {
    stat: vi.fn().mockResolvedValue({ ...reference, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5n, revision: revisions[0] }),
    replace: vi.fn().mockImplementation(async () => ({ ref: reference, metadata: { ...reference, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5n, revision: replaceRevisions.shift() ?? 'missing' } })),
    getCurrentVersion: vi.fn().mockImplementation(async () => {
      const storageRevision = revisions.shift() ?? 'missing';
      return { ref: { ...reference, versionId: `revision-${storageRevision}` }, storageRevision, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5n };
    }),
    preserveVersion: vi.fn().mockResolvedValue(undefined),
    openVersion: vi.fn(),
    delete: vi.fn(),
  };
  const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities: new Set([DocumentCapability.EDIT]) }) };
  const folders = { requireCreate: vi.fn() };
  const registry = { resolve: vi.fn().mockReturnValue({ engine, capabilities: { edit: true } }) };
  const coordinator = new FileSaveCoordinator(
    database as never,
    authorization as never,
    folders as never,
    registry as never,
    storage as never,
    { versionHistoryLimit: 50 } as never,
    {} as never,
  );
  return { coordinator, engine, storage, database, reference, operations };
}

function request(engine: unknown, operationId: string, expectedRevision: string) {
  return {
    userId: 'user',
    nodeId: 'node',
    engine: engine as never,
    operationId,
    payload: { expectedRevision, blocks: [] },
  };
}

describe('FileSaveCoordinator revision lifecycle', () => {
  it('returns the final provider stat revision after preservation', async () => {
    const { coordinator, storage, engine } = harness(['R1', 'R2', 'R3']);

    const result = await coordinator.save(request(engine, 'save-1', 'R1'));

    expect(storage.replace).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expectedRevision: 'R1' });
    expect(storage.preserveVersion).toHaveBeenCalledTimes(2);
    expect(storage.getCurrentVersion).toHaveBeenCalledTimes(3);
    expect(result.storageRevision).toBe('R3');
    expect(result.model).toEqual({ storageRevision: 'R3' });
    expect(engine.openModel).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ storageRevision: 'R3' }));
  });

  it('uses the successful save revision for the immediate second save', async () => {
    const { coordinator, storage, engine } = harness(['R1', 'R2', 'R3', 'R3', 'R4', 'R5'], ['R2', 'R4']);
    storage.stat.mockResolvedValueOnce({ revision: 'R1' }).mockResolvedValueOnce({ revision: 'R3' });

    const first = await coordinator.save(request(engine, 'save-1', 'R1'));
    await coordinator.save(request(engine, 'save-2', first.storageRevision));

    expect(storage.replace).toHaveBeenNthCalledWith(1, expect.anything(), expect.anything(), { expectedRevision: 'R1' });
    expect(storage.replace).toHaveBeenNthCalledWith(2, expect.anything(), expect.anything(), { expectedRevision: 'R3' });
  });

  it('returns a conflict when the precheck revision changed remotely', async () => {
    const { coordinator, database, storage, engine } = harness(['R2', 'R2', 'R2']);

    await expect(coordinator.save(request(engine, 'save-conflict', 'R1'))).rejects.toMatchObject({ status: 409 });
    expect(storage.replace).not.toHaveBeenCalled();
    expect(database.prisma.fileSaveOperation.create).not.toHaveBeenCalled();
  });

  it('does not leave an idempotency record behind when history preservation fails before a provider write', async () => {
    const { coordinator, database, storage, engine } = harness(['R1', 'R2', 'R3']);
    storage.getCurrentVersion.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(coordinator.save(request(engine, 'save-retry', 'R1'))).rejects.toMatchObject({ status: 503 });
    expect(database.prisma.fileSaveOperation.create).not.toHaveBeenCalled();
    expect(storage.replace).not.toHaveBeenCalled();

    await expect(coordinator.save(request(engine, 'save-retry', 'R1'))).resolves.toMatchObject({ storageRevision: 'R3' });
    expect(storage.replace).toHaveBeenCalledOnce();
  });

  it('replays a completed operation instead of writing the provider again', async () => {
    const { coordinator, database, storage, engine } = harness();
    database.prisma.fileSaveOperation.findUnique.mockResolvedValue({ fileId: 'file', expectedRevision: 'R1', operationType: 'SAVE', status: 'COMPLETED', resultRevision: 'R3' });

    await expect(coordinator.save(request(engine, 'save-replay', 'R1'))).resolves.toMatchObject({ storageRevision: 'R3' });
    expect(storage.replace).not.toHaveBeenCalled();
  });

  it('does not replace the provider twice when history finalization fails', async () => {
    const { coordinator, database, storage, engine } = harness(['R1', 'R2', 'R3']);
    database.prisma.$transaction.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(coordinator.save(request(engine, 'save-finalization', 'R1'))).rejects.toMatchObject({ status: 503 });
    expect(storage.replace).toHaveBeenCalledOnce();

    await expect(coordinator.save(request(engine, 'save-finalization', 'R1'))).resolves.toMatchObject({ storageRevision: 'R3' });
    expect(storage.replace).toHaveBeenCalledOnce();
  });
});
