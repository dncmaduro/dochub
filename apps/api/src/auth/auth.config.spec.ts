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
      webOrigins: [],
    });
  });

  it('fails closed for weak production settings and accepts explicit HTTPS origins', () => {
    const production = {
      NODE_ENV: 'production',
      AUTH_ACCESS_TOKEN_SECRET: 'c97d4cf49f3a85d7610b629e93a480bc',
      AUTH_REFRESH_COOKIE_SECURE: 'true',
      WEB_ORIGIN: 'https://app.example.test,https://admin.example.test',
      GOOGLE_CLIENT_ID: 'client-id',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      GOOGLE_REDIRECT_URI: 'https://api.example.test/auth/google/callback',
      AUTH_LOGIN_SUCCESS_REDIRECT_URL: 'https://app.example.test/auth/callback',
    };
    expect(loadAuthConfig(production).webOrigins).toEqual([
      'https://app.example.test',
      'https://admin.example.test',
    ]);
    expect(() =>
      loadAuthConfig({
        ...production,
        AUTH_ACCESS_TOKEN_SECRET: 'replace-with-secret-value-please',
      }),
    ).toThrow('high-entropy');
    expect(() =>
      loadAuthConfig({ ...production, AUTH_REFRESH_COOKIE_SECURE: 'false' }),
    ).toThrow('must be true in production');
    expect(() =>
      loadAuthConfig({ ...production, WEB_ORIGIN: 'http://app.example.test' }),
    ).toThrow('must use https');
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

  it('requires the complete Google OIDC configuration when any Google value is supplied', () => {
    expect(() =>
      loadAuthConfig({
        AUTH_ACCESS_TOKEN_SECRET: 'test-secret',
        GOOGLE_CLIENT_ID: 'client-id',
      }),
    ).toThrow('must be configured together');

    expect(
      loadAuthConfig({
        AUTH_ACCESS_TOKEN_SECRET: 'test-secret',
        GOOGLE_CLIENT_ID: 'client-id',
        GOOGLE_CLIENT_SECRET: 'client-secret',
        GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
        AUTH_LOGIN_SUCCESS_REDIRECT_URL: 'http://localhost:5173/auth/callback',
        WEB_ORIGIN: 'http://localhost:5173',
      }).google,
    ).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'http://localhost:3000/auth/google/callback',
      loginSuccessRedirectUrl: 'http://localhost:5173/auth/callback',
    });
  });
});
