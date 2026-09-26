import { describe, expect, it } from 'vitest';
import { loadEditorConfig } from './editor.config.js';

const env = {
  ONLYOFFICE_PUBLIC_URL: 'http://localhost:8082',
  ONLYOFFICE_INTERNAL_API_URL: 'http://host.docker.internal:3000',
  ONLYOFFICE_JWT_SECRET: 'a'.repeat(32),
  ONLYOFFICE_FETCH_TOKEN_SECRET: 'b'.repeat(32),
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
    expect(() =>
      loadEditorConfig({ ...env, ONLYOFFICE_JWT_SECRET: 'short' }),
    ).toThrow('at least 32');
    expect(() =>
      loadEditorConfig({ ...env, ONLYOFFICE_FETCH_TOKEN_TTL_SECONDS: '2' }),
    ).toThrow('between 60 and 3600');
  });
});
