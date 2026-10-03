import { describe, expect, it } from 'vitest';
import { AuthCookieService } from './auth-cookie.service.js';
import type { AuthConfig } from './auth.config.js';

const config: AuthConfig = {
  accessTokenSecret: 'test-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  refreshCookieName: 'dochub_refresh',
  refreshCookieSecure: true,
  refreshCookieSameSite: 'lax',
  webOrigins: ['https://app.example.test'],
};

describe('AuthCookieService', () => {
  it('uses an HttpOnly, secure, path-limited, expiring refresh cookie', () => {
    const service = new AuthCookieService(config);
    expect(service.refreshOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  });

  it('does not set a domain unless an operator explicitly configures one', () => {
    expect(new AuthCookieService(config).refreshOptions()).not.toHaveProperty('domain');
  });
});
