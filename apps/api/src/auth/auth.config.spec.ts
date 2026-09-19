import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from './auth.config.js';

describe('loadAuthConfig', () => {
  it('requires an access-token secret and applies safe defaults', () => {
    expect(() => loadAuthConfig({})).toThrow(
      'AUTH_ACCESS_TOKEN_SECRET is required',
    );

    expect(
      loadAuthConfig({ AUTH_ACCESS_TOKEN_SECRET: 'test-secret' }),
    ).toMatchObject({
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      refreshCookieName: 'dochub_refresh',
      refreshCookieSecure: false,
      refreshCookieSameSite: 'lax',
    });
  });

  it('rejects insecure SameSite=None cookies and invalid positive integers', () => {
    expect(() =>
      loadAuthConfig({
        AUTH_ACCESS_TOKEN_SECRET: 'test-secret',
        AUTH_REFRESH_COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow(
      'AUTH_REFRESH_COOKIE_SAME_SITE=none requires AUTH_REFRESH_COOKIE_SECURE=true',
    );

    expect(() =>
      loadAuthConfig({
        AUTH_ACCESS_TOKEN_SECRET: 'test-secret',
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '0',
      }),
    ).toThrow('AUTH_ACCESS_TOKEN_TTL_SECONDS must be a positive integer');
  });
});
