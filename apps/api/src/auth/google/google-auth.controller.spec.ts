import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthCookieService } from '../auth-cookie.service.js';
import type { AuthConfig } from '../auth.config.js';
import { GoogleAuthService } from './google-auth.service.js';
import { GoogleAuthController } from './google-auth.controller.js';

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

function controllerFor() {
  const googleAuth = {
    beginAuthorization: vi.fn().mockResolvedValue({
      authorizationUrl:
        'https://accounts.google.com/o/oauth2/v2/auth?scope=openid',
      state: 'state',
      nonce: 'nonce',
      codeVerifier: 'verifier',
    }),
    completeAuthorization: vi.fn().mockResolvedValue({
      accessToken: 'application-access-token',
      refreshToken: 'application-refresh-token',
      expiresIn: 900,
    }),
  } as unknown as GoogleAuthService;
  const authCookies = {
    refreshCookieName: vi.fn().mockReturnValue('dochub_refresh'),
    refreshOptions: vi.fn().mockReturnValue({ httpOnly: true, path: '/auth' }),
    googleFlowOptions: vi.fn().mockReturnValue({
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth/google/callback',
    }),
  } as unknown as AuthCookieService;
  const response = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };

  return {
    controller: new GoogleAuthController(googleAuth, authCookies, config),
    googleAuth,
    authCookies,
    response,
  };
}

describe('GoogleAuthController', () => {
  it('sets short-lived flow cookies before redirecting to Google', async () => {
    const { controller, response } = controllerFor();

    await controller.start(response as never);

    expect(response.cookie).toHaveBeenCalledTimes(3);
    expect(response.redirect).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?scope=openid',
    );
  });

  it('sets only the application refresh cookie and redirects to the fixed success URL', async () => {
    const { controller, googleAuth, response } = controllerFor();
    const request = {
      query: { code: 'code', state: 'state' },
      cookies: {
        dochub_google_state: 'state',
        dochub_google_nonce: 'nonce',
        dochub_google_verifier: 'verifier',
      },
      ip: '127.0.0.1',
      get: vi.fn().mockReturnValue('test-agent'),
    };

    await controller.callback(request as never, response as never);

    expect(googleAuth.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'code',
        state: 'state',
        ipAddress: '127.0.0.1',
      }),
    );
    expect(response.cookie).toHaveBeenCalledWith(
      'dochub_refresh',
      'application-refresh-token',
      expect.any(Object),
    );
    expect(response.clearCookie).toHaveBeenCalledTimes(3);
    expect(response.redirect).toHaveBeenCalledWith(
      'http://localhost:5173/auth/callback',
    );
    expect(JSON.stringify(response.redirect.mock.calls)).not.toContain(
      'application-access-token',
    );
    expect(JSON.stringify(response.redirect.mock.calls)).not.toContain(
      'application-refresh-token',
    );
  });

  it('rejects missing flow cookies and clears any residual flow state', async () => {
    const { controller, response } = controllerFor();
    const request = {
      query: { code: 'code', state: 'state' },
      cookies: {},
      get: vi.fn(),
    };

    await expect(
      controller.callback(request as never, response as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(response.clearCookie).toHaveBeenCalledTimes(3);
  });
});
