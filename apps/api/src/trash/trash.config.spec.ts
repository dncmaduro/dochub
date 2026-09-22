import { describe, expect, it } from 'vitest';
import { loadTrashConfig } from './trash.config.js';
describe('loadTrashConfig', () => {
  it('accepts positive integer retention days', () => {
    expect(loadTrashConfig({ TRASH_RETENTION_DAYS: '30' } as NodeJS.ProcessEnv)).toEqual({ retentionDays: 30 });
  });
  it.each(['0', '-1', '1.5', 'nope'])('rejects %s', value => {
    expect(() => loadTrashConfig({ TRASH_RETENTION_DAYS: value } as NodeJS.ProcessEnv)).toThrow();
  });
});
