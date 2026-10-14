import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { FileHistoryService } from './file-history.service.js';

function harness(operation: Record<string, unknown> | null) {
  const database = {
    prisma: {
      fileRevision: { findFirst: vi.fn().mockResolvedValue({ id: 'source-revision', fileId: 'file', providerVersionId: 'provider-source' }) },
      fileSaveOperation: { findUnique: vi.fn().mockResolvedValue(operation), findUniqueOrThrow: vi.fn(), findFirst: vi.fn() },
      node: { findFirst: vi.fn().mockResolvedValue({ file: { id: 'file', backingType: 'GOOGLE_DRIVE', driveFile: { driveFileId: 'drive-file' } } }) },
    },
  };
  const storage = { getCurrentVersion: vi.fn(), preserveVersion: vi.fn(), openVersion: vi.fn(), replace: vi.fn() };
  const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities: new Set([DocumentCapability.RESTORE_VERSION]) }) };
  const service = new FileHistoryService(database as never, authorization as never, storage as never, { versionHistoryLimit: 50 } as never, {} as never);
  return { service, storage };
}

describe('FileHistoryService restore mutation identity', () => {
  it('replays a completed restore without another provider replacement', async () => {
    const { service, storage } = harness({
      fileId: 'file', operationType: 'RESTORE', sourceRevisionId: 'source-revision', expectedRevision: 'R3', status: 'COMPLETED', resultRevision: 'R4',
    });

    await expect(service.restoreVersion('user', 'node', 'source-revision', 'R3', 'restore-1')).resolves.toEqual({ storageRevision: 'R4', operationId: 'restore-1' });
    expect(storage.replace).not.toHaveBeenCalled();
  });
});
