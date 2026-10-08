import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../auth/auth.config.js';
import { loadDriveConfig } from './drive.config.js';

const auth = {
  accessTokenSecret: 'test-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  refreshCookieName: 'dochub_refresh',
  refreshCookieSecure: false,
  refreshCookieSameSite: 'lax',
  webOrigins: ['https://app.example.test'],
  google: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://api.example.test/auth/google/callback',
    loginSuccessRedirectUrl: 'https://app.example.test/auth/callback',
  },
} satisfies AuthConfig;

describe('loadDriveConfig', () => {
  it('derives the integration callback and Admin success destination', () => {
    const config = loadDriveConfig(auth, {
      NODE_ENV: 'development',
      DRIVE_TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
    });

    expect(config).toMatchObject({
      enabled: true,
      redirectUri: 'https://api.example.test/drive/integration/callback',
      successRedirectUrl: 'https://app.example.test/admin?tab=drive',
    });
  });
});
