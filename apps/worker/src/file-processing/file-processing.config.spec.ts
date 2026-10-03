import { loadFileProcessingConfig } from './file-processing.config.js';
import { isSearchableFileMimeType } from '@dochub/database';

describe('file-processing configuration', () => {
  it('uses conservative defaults', () => {
    const config = loadFileProcessingConfig({});
    expect(config).toMatchObject({
      pollSeconds: 15,
      batchSize: 20,
      concurrency: 2,
      leaseSeconds: 300,
      maxAttempts: 5,
      tikaRequestTimeoutSeconds: 60,
      tikaMaxTextBytes: 16 * 1024 * 1024,
    });
    expect(config.tikaUrl.href).toBe('http://localhost:9998/');
  });

  it.each(['', '0', '-1', 'x', '501'])('rejects bad batch values', (value) => {
    expect(() =>
      loadFileProcessingConfig({ FILE_PROCESSING_BATCH_SIZE: value }),
    ).toThrow();
  });

  it('rejects a non-HTTP Tika URL', () => {
    expect(() =>
      loadFileProcessingConfig({ TIKA_URL: 'file:///tmp/tika' }),
    ).toThrow();
  });

  it('keeps a lease longer than the bounded Tika operation', () => {
    expect(() =>
      loadFileProcessingConfig({
        FILE_PROCESSING_LEASE_SECONDS: '90',
        TIKA_REQUEST_TIMEOUT_SECONDS: '60',
      }),
    ).toThrow('FILE_PROCESSING_LEASE_SECONDS');
  });

  it('limits extraction to trusted document MIME types', () => {
    expect(isSearchableFileMimeType('application/pdf')).toBe(true);
    expect(isSearchableFileMimeType('application/vnd.ms-excel')).toBe(true);
    expect(isSearchableFileMimeType('image/png')).toBe(false);
    expect(isSearchableFileMimeType('video/mp4')).toBe(false);
  });
});
