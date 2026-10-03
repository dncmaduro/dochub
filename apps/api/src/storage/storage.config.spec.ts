import { describe, expect, it } from 'vitest';
import { loadStorageConfig } from './storage.config.js';

describe('loadStorageConfig', () => {
  it('requires distinct absolute storage and staging roots', () => {
    const env = {
      STORAGE_DRIVER: 'local',
      STORAGE_ROOT: '/srv/dochub/storage',
      UPLOAD_TEMP_ROOT: '/srv/dochub/uploads',
      UPLOAD_MAX_BYTES: '1024',
    };
    expect(loadStorageConfig(env)).toMatchObject({ root: env.STORAGE_ROOT });
    expect(() =>
      loadStorageConfig({ ...env, UPLOAD_TEMP_ROOT: env.STORAGE_ROOT }),
    ).toThrow('different paths');
  });
});
