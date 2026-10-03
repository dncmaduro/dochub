import { describe, expect, it } from 'vitest';
import { loadRuntimeSecurityConfig } from './runtime-security.config.js';

describe('loadRuntimeSecurityConfig', () => {
  it('requires a PostgreSQL URL and bounds reverse-proxy/body settings', () => {
    expect(() => loadRuntimeSecurityConfig({})).toThrow(
      'DATABASE_URL is required',
    );
    expect(() =>
      loadRuntimeSecurityConfig({ DATABASE_URL: 'https://db.example' }),
    ).toThrow('PostgreSQL');
    expect(
      loadRuntimeSecurityConfig({
        DATABASE_URL: 'postgresql://user:pass@db.example/dochub',
        TRUST_PROXY_HOPS: '1',
        API_JSON_BODY_LIMIT_BYTES: '2048',
      }),
    ).toMatchObject({ trustProxyHops: 1, jsonBodyLimitBytes: 2048 });
    expect(() =>
      loadRuntimeSecurityConfig({
        DATABASE_URL: 'postgresql://db/dochub',
        TRUST_PROXY_HOPS: '3',
      }),
    ).toThrow('between 0 and 2');
  });
});
