import { FileSaveOperationStatus, FileSaveOperationType, finalizeFileMutationOperation } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';

function harness() {
  const operation = {
    operationId: 'save-1', fileId: 'file', expectedRevision: 'R1',
    operationType: FileSaveOperationType.SAVE, source: 'MANUAL_SAVE',
    status: FileSaveOperationStatus.PROVIDER_WRITTEN, previousStorageRevision: 'R1',
    previousProviderVersionId: 'provider-R1', previousSizeBytes: 1n,
    previousChecksum: null, resultRevision: 'R2', providerVersionId: 'provider-R2',
    resultSizeBytes: 2n, resultChecksum: null, sourceRevisionId: null,
    createdById: 'user', completedAt: null,
    file: { id: 'file', nodeId: 'node', driveFileId: 'drive-row' },
  };
  const revisions = new Map<string, { id: string; sequence: number }>();
  let sequence = 0;
  const tx = {
    fileSaveOperation: {
      findUniqueOrThrow: vi.fn().mockImplementation(async () => operation),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => Object.assign(operation, data)),
    },
    fileRevision: {
      findUnique: vi.fn().mockImplementation(async () => revisions.get('save-1') ?? null),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async ({ data }: { data: { operationId?: string; sequence: number } }) => {
        const row = { id: data.operationId ?? 'initial', sequence: data.sequence };
        if (data.operationId) revisions.set(data.operationId, row);
        return row;
      }),
    },
    file: { update: vi.fn().mockImplementation(async () => ({ revisionSequence: ++sequence })) },
    driveFile: { update: vi.fn() },
    node: { update: vi.fn() },
    auditLog: { upsert: vi.fn() },
    outboxEvent: { upsert: vi.fn() },
  };
  const database = { $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)) };
  return { database, operation, tx };
}

describe('finalizeFileMutationOperation', () => {
  it('is idempotent and creates the initial/manual history, audit, and outbox only once', async () => {
    const { database, operation, tx } = harness();

    await expect(finalizeFileMutationOperation(database as never, 'save-1')).resolves.toMatchObject({ storageRevision: 'R2', sequence: 2 });
    await expect(finalizeFileMutationOperation(database as never, 'save-1')).resolves.toMatchObject({ storageRevision: 'R2', sequence: 2 });

    expect(tx.fileRevision.create).toHaveBeenCalledTimes(2); // initial + operation result
    expect(tx.auditLog.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { mutationOperationId: 'save-1' } }));
    expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { mutationOperationId: 'save-1' } }));
    expect(operation.status).toBe(FileSaveOperationStatus.COMPLETED);
  });
});
