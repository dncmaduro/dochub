import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DriveProviderError } from '../drive/google-drive.provider.js';
import {
  StorageObjectNotFoundError,
  StorageProviderUnavailableError,
} from './storage.errors.js';
import { GoogleDriveStorageProvider } from './google-drive-storage.provider.js';

function driveHarness() {
  const drive = {
    putStorageObject: vi.fn().mockResolvedValue({
      id: 'drive-object-1',
      mimeType: 'application/pdf',
      size: '5',
      version: '7',
      modifiedTime: '2026-10-12T00:00:00.000Z',
      webViewLink: 'https://drive.example/should-not-leak',
      parents: ['logical-parent-must-not-be-used'],
    }),
    openStorageObject: vi.fn().mockResolvedValue({
      stream: Readable.from([Buffer.from('hello')]),
      mimeType: 'application/pdf',
      sizeBytes: 5n,
      range: null,
    }),
    replaceStorageObject: vi.fn().mockResolvedValue({
      id: 'drive-object-1',
      mimeType: 'application/pdf',
      size: '6',
      version: '8',
    }),
    deleteStorageObject: vi.fn().mockResolvedValue(undefined),
    statStorageObject: vi.fn().mockResolvedValue({
      id: 'drive-object-1',
      mimeType: 'application/pdf',
      size: '5',
      version: '7',
    }),
  };
  return { drive, provider: new GoogleDriveStorageProvider(drive as never) };
}

describe('GoogleDriveStorageProvider', () => {
  it('puts an opaque object and normalizes storage metadata only', async () => {
    const { provider, drive } = driveHarness();
    const stored = await provider.put({
      stream: Readable.from([Buffer.from('hello')]),
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });

    expect(stored.ref).toEqual({
      provider: 'GOOGLE_DRIVE',
      objectId: 'drive-object-1',
    });
    expect(stored.metadata).toMatchObject({
      mimeType: 'application/pdf',
      sizeBytes: 5n,
      revision: '7',
    });
    expect(stored.metadata).not.toHaveProperty('webViewLink');
    expect(drive.putStorageObject).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}\.pdf$/),
      'application/pdf',
      expect.anything(),
      undefined,
    );
  });

  it('opens exact bytes and translates ranges without exposing Drive details', async () => {
    const { provider, drive } = driveHarness();
    const result = await provider.openRead(
      { provider: 'GOOGLE_DRIVE', objectId: 'drive-object-1' },
      { range: { start: 2, end: 4 } },
    );

    expect(drive.openStorageObject).toHaveBeenCalledWith(
      'drive-object-1',
      'bytes=2-4',
    );
    expect(result.metadata).toMatchObject({
      provider: 'GOOGLE_DRIVE',
      objectId: 'drive-object-1',
      sizeBytes: 5n,
    });
    expect(Buffer.concat(await readChunks(result.stream))).toEqual(
      Buffer.from('hello'),
    );
  });

  it('replaces the same object after checking the expected revision', async () => {
    const { provider, drive } = driveHarness();
    const result = await provider.replace(
      { provider: 'GOOGLE_DRIVE', objectId: 'drive-object-1' },
      {
        stream: Readable.from([Buffer.from('updated')]),
        mimeType: 'application/pdf',
      },
      { expectedRevision: '7' },
    );

    expect(drive.replaceStorageObject).toHaveBeenCalledWith(
      'drive-object-1',
      'application/pdf',
      expect.anything(),
      undefined,
    );
    expect(result.ref.objectId).toBe('drive-object-1');
    expect(result.metadata.revision).toBe('8');
  });

  it('does not replace after a revision conflict and deletes only when explicitly called', async () => {
    const { provider, drive } = driveHarness();
    drive.statStorageObject.mockResolvedValueOnce({
      id: 'drive-object-1',
      mimeType: 'application/pdf',
      size: '5',
      version: '9',
    });

    await expect(
      provider.replace(
        { provider: 'GOOGLE_DRIVE', objectId: 'drive-object-1' },
        { stream: Readable.from([Buffer.from('updated')]), mimeType: 'application/pdf' },
        { expectedRevision: '7' },
      ),
    ).rejects.toThrow('revision has changed');
    expect(drive.replaceStorageObject).not.toHaveBeenCalled();

    await provider.delete({ provider: 'GOOGLE_DRIVE', objectId: 'drive-object-1' });
    expect(drive.deleteStorageObject).toHaveBeenCalledWith('drive-object-1');
  });

  it('maps provider failures to safe storage errors', async () => {
    const { provider, drive } = driveHarness();
    drive.statStorageObject.mockRejectedValueOnce(new DriveProviderError('provider', 404));
    await expect(
      provider.stat({ provider: 'GOOGLE_DRIVE', objectId: 'missing' }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);

    drive.statStorageObject.mockRejectedValueOnce(new DriveProviderError('network'));
    await expect(
      provider.stat({ provider: 'GOOGLE_DRIVE', objectId: 'offline' }),
    ).rejects.toBeInstanceOf(StorageProviderUnavailableError);
  });
});

async function readChunks(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return chunks;
}
