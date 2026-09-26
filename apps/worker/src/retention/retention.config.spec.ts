import { loadRetentionConfig } from './retention.config.js';

describe('retention configuration', () => {
  it('defaults to 60 seconds, 20 operations, and concurrency 1', () => {
    expect(loadRetentionConfig({})).toEqual({
      pollSeconds: 60,
      batchSize: 20,
      operationConcurrency: 1,
    });
  });
  it('accepts configured limits', () => {
    expect(
      loadRetentionConfig({
        TRASH_RETENTION_POLL_SECONDS: '0.5',
        TRASH_RETENTION_BATCH_SIZE: '500',
        TRASH_RETENTION_OPERATION_CONCURRENCY: '8',
      }),
    ).toEqual({ pollSeconds: 0.5, batchSize: 500, operationConcurrency: 8 });
  });
  it.each(['0', '-1', '', 'NaN', 'Infinity', '2147484'])(
    'rejects invalid polling %s',
    (value) => {
      expect(() =>
        loadRetentionConfig({ TRASH_RETENTION_POLL_SECONDS: value }),
      ).toThrow();
    },
  );
  it.each(['0', '-1', '', '501', '1.5', 'bad'])(
    'rejects invalid batch %s',
    (value) => {
      expect(() =>
        loadRetentionConfig({ TRASH_RETENTION_BATCH_SIZE: value }),
      ).toThrow();
    },
  );
  it.each(['0', '-1', '', '9', '1.5', 'bad'])(
    'rejects invalid concurrency %s',
    (value) => {
      expect(() =>
        loadRetentionConfig({ TRASH_RETENTION_OPERATION_CONCURRENCY: value }),
      ).toThrow();
    },
  );
});
