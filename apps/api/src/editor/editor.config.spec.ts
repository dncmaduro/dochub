import { describe, expect, it } from 'vitest';
import { loadEditorConfig } from './editor.config.js';

const env = {
  ONLYOFFICE_PUBLIC_URL: 'http://localhost:8082',
  ONLYOFFICE_INTERNAL_API_URL: 'http://host.docker.internal:3000',
  ONLYOFFICE_JWT_SECRET: 'c97d4cf49f3a85d7610b629e93a480bc',
  ONLYOFFICE_FETCH_TOKEN_SECRET: '18e7094c535bb5ad2446dcb4e031d04d',
};

describe('editor configuration', () => {
  it('is disabled only when all ONLYOFFICE settings are absent', () => {
    expect(loadEditorConfig({})).toBeUndefined();
    expect(() =>
      loadEditorConfig({ ONLYOFFICE_PUBLIC_URL: 'http://localhost:8082' }),
    ).toThrow('is required');
  });

  it('validates URLs, secrets, and bounded fetch TTL', () => {
    expect(loadEditorConfig(env)?.fetchTokenTtlSeconds).toBe(900);
    expect(loadEditorConfig(env)?.callbackTokenTtlSeconds).toBe(3600);
    expect(loadEditorConfig(env)?.editCloseGraceSeconds).toBe(60);
    expect(() =>
      loadEditorConfig({ ...env, ONLYOFFICE_JWT_SECRET: 'short' }),
    ).toThrow('at least 32');
    expect(() =>
      loadEditorConfig({ ...env, ONLYOFFICE_FETCH_TOKEN_TTL_SECONDS: '2' }),
    ).toThrow('between 60 and 3600');
    expect(() =>
      loadEditorConfig({ ...env, ONLYOFFICE_EDIT_CLOSE_GRACE_SECONDS: '2' }),
    ).toThrow('between 15 and 900');
  });

  it('rejects insecure public document-server URLs and placeholder secrets in production', () => {
    expect(() => loadEditorConfig({ ...env, NODE_ENV: 'production' })).toThrow(
      'must use https',
    );
    expect(() =>
      loadEditorConfig({
        ...env,
        NODE_ENV: 'production',
        ONLYOFFICE_PUBLIC_URL: 'https://docs.example.test',
        ONLYOFFICE_JWT_SECRET: 'replace-with-a-real-secret-value-now',
      }),
    ).toThrow('must not use a placeholder');
  });
});
