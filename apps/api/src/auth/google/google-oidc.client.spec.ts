import { describe, expect, it, vi } from 'vitest';

const oidc = vi.hoisted(() => ({
  discovery: vi.fn().mockResolvedValue({}),
  buildAuthorizationUrl: vi
    .fn()
    .mockReturnValue(new URL('https://accounts.google.com/o/oauth2/v2/auth')),
  authorizationCodeGrant: vi.fn(),
}));

vi.mock('openid-client', () => oidc);

import type { AuthConfig } from '../auth.config.js';
import { OpenIdClientGoogleOidcClient } from './google-oidc.client.js';

const config: AuthConfig = {
  accessTokenSecret: 'test-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  refreshCookieName: 'dochub_refresh',
  refreshCookieSecure: false,
  refreshCookieSameSite: 'lax',
  google: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'http://localhost:3000/auth/google/callback',
    loginSuccessRedirectUrl: 'http://localhost:5173/auth/callback',
  },
};

describe('OpenIdClientGoogleOidcClient', () => {
  it('uses exactly the login scopes and required authorization-code parameters', async () => {
    const client = new OpenIdClientGoogleOidcClient(config);

    await client.authorizationUrl({
      state: 'state',
      nonce: 'nonce',
      codeChallenge: 'challenge',
    });

    expect(oidc.discovery).toHaveBeenCalledWith(
      new URL('https://accounts.google.com'),
      'client-id',
      'client-secret',
    );
    expect(oidc.buildAuthorizationUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response_type: 'code',
        client_id: 'client-id',
        redirect_uri: 'http://localhost:3000/auth/google/callback',
        scope: 'openid email profile',
        state: 'state',
        nonce: 'nonce',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
      }),
    );
  });

  it('delegates code exchange and ID-token validation to openid-client with all checks', async () => {
    const claims = {
      sub: 'subject',
      email: 'member@example.test',
      email_verified: true,
    };
    oidc.authorizationCodeGrant.mockResolvedValue({ claims: () => claims });
    const client = new OpenIdClientGoogleOidcClient(config);

    await expect(
      client.validateCallback({
        code: 'code',
        state: 'state',
        nonce: 'nonce',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual(claims);
    expect(oidc.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        href: expect.stringContaining('code=code'),
      }),
      {
        expectedState: 'state',
        expectedNonce: 'nonce',
        pkceCodeVerifier: 'verifier',
      },
    );
  });
});
