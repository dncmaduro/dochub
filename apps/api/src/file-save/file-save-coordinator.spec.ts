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
  const transaction = {
    file: {
      update: vi.fn().mockResolvedValue({ revisionSequence: 2 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ revisionSequence: 2 }),
    },
    fileRevision: { count: vi.fn().mockResolvedValue(1), create: vi.fn() },
    fileSaveOperation: { update: vi.fn() },
    driveFile: { update: vi.fn() },
    node: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    outboxEvent: { create: vi.fn() },
  };
  const database = {
    prisma: {
      fileSaveOperation: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
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
  return { coordinator, engine, storage, database, reference };
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
});
