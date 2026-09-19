import { UnauthorizedException } from '@nestjs/common';
import { AuthProvider, UserStatus } from '@dochub/database';
import * as oidc from 'openid-client';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../../database/database.service.js';
import { AuthSessionService } from '../auth-session.service.js';
import {
  GoogleAuthService,
  type GoogleCallbackInput,
} from './google-auth.service.js';
import type { GoogleOidcClient } from './google-oidc.client.js';

const userId = '6f874294-33cc-4d34-bd9a-8db60cc2a6d4';
const otherUserId = '536b63b5-9b67-4ea5-bdc3-9d6ca1c85ccf';
const callbackInput: GoogleCallbackInput = {
  code: 'authorization-code',
  state: 'state',
  expectedState: 'state',
  nonce: 'nonce',
  codeVerifier: 'code-verifier',
  ipAddress: '127.0.0.1',
  userAgent: 'test-agent',
};

function googleClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'google-stable-subject',
    email: 'Member@Example.test',
    email_verified: true,
    ...overrides,
  };
}

function transactionMock() {
  return {
    authAccount: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'account-id' }),
    },
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: userId, status: UserStatus.ACTIVE }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: userId }]),
  };
}

function serviceFor(
  transaction = transactionMock(),
  claims: unknown = googleClaims(),
): {
  service: GoogleAuthService;
  transaction: ReturnType<typeof transactionMock>;
  database: DatabaseService;
  sessions: AuthSessionService;
  oidcClient: GoogleOidcClient;
} {
  const database = {
    prisma: {
      $transaction: vi.fn((callback) => callback(transaction)),
    },
  } as unknown as DatabaseService;
  const sessions = {
    createSession: vi.fn().mockResolvedValue({
      accessToken: 'application-access-token',
      refreshToken: 'application-refresh-token',
      expiresIn: 900,
    }),
  } as unknown as AuthSessionService;
  const oidcClient = {
    authorizationUrl: vi
      .fn()
      .mockResolvedValue('https://accounts.google.com/o/oauth2/v2/auth'),
    validateCallback: vi.fn().mockResolvedValue(claims),
  } as unknown as GoogleOidcClient;

  return {
    service: new GoogleAuthService(database, sessions, oidcClient),
    transaction,
    database,
    sessions,
    oidcClient,
  };
}

describe('GoogleAuthService OIDC flow', () => {
  it('creates state, nonce, and S256 PKCE values for an authorization request', async () => {
    const { service, oidcClient } = serviceFor();

    const flow = await service.beginAuthorization();

    expect(flow.state).toBeTruthy();
    expect(flow.nonce).toBeTruthy();
    expect(flow.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(await oidc.calculatePKCECodeChallenge(flow.codeVerifier)).toBe(
      vi.mocked(oidcClient.authorizationUrl).mock.calls[0][0].codeChallenge,
    );
  });

  it('rejects mismatched state before calling Google', async () => {
    const { service, oidcClient } = serviceFor();

    await expect(
      service.completeAuthorization({
        ...callbackInput,
        expectedState: 'different-state',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(oidcClient.validateCallback).not.toHaveBeenCalled();
  });

  it.each([
    ['unverified email', googleClaims({ email_verified: false })],
    ['missing subject', googleClaims({ sub: undefined })],
    ['missing email', googleClaims({ email: undefined })],
  ])('rejects an identity with %s', async (_scenario, claims) => {
    const { service, database, sessions } = serviceFor(
      transactionMock(),
      claims,
    );

    await expect(
      service.completeAuthorization(callbackInput),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.prisma.$transaction).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });
});

describe('GoogleAuthService account binding', () => {
  it('uses an existing Google subject binding even if the verified email changed', async () => {
    const transaction = transactionMock();
    transaction.authAccount.findUnique.mockResolvedValueOnce({
      user: { id: otherUserId, status: UserStatus.ACTIVE },
    });
    const { service, sessions } = serviceFor(
      transaction,
      googleClaims({ email: 'new-email@example.test' }),
    );

    await service.completeAuthorization(callbackInput);

    expect(transaction.$queryRaw).not.toHaveBeenCalled();
    expect(transaction.authAccount.create).not.toHaveBeenCalled();
    expect(sessions.createSession).toHaveBeenCalledWith({
      userId: otherUserId,
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
    });
  });

  it('does not auto-provision an unknown verified email', async () => {
    const transaction = transactionMock();
    transaction.$queryRaw.mockResolvedValue([]);
    const { service, sessions } = serviceFor(transaction);

    await expect(
      service.completeAuthorization(callbackInput),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(transaction.authAccount.create).not.toHaveBeenCalled();
    expect(sessions.createSession).not.toHaveBeenCalled();
  });

  it('binds an INVITED user, activates it atomically, and creates the existing app session', async () => {
    const transaction = transactionMock();
    transaction.user.findUnique.mockResolvedValue({
      id: userId,
      status: UserStatus.INVITED,
    });
    const { service, sessions } = serviceFor(transaction);

    await service.completeAuthorization(callbackInput);

    expect(transaction.authAccount.create).toHaveBeenCalledWith({
      data: {
        userId,
        provider: AuthProvider.GOOGLE,
        providerAccountId: 'google-stable-subject',
      },
    });
    expect(transaction.user.updateMany).toHaveBeenCalledWith({
      where: { id: userId, status: UserStatus.INVITED },
      data: { status: UserStatus.ACTIVE },
    });
    expect(sessions.createSession).toHaveBeenCalledTimes(1);
  });

  it('binds an ACTIVE unbound user without changing its status', async () => {
    const transaction = transactionMock();
    const { service } = serviceFor(transaction);

    await service.completeAuthorization(callbackInput);

    expect(transaction.authAccount.create).toHaveBeenCalledTimes(1);
    expect(transaction.user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a SUSPENDED user and a user already bound to another Google subject', async () => {
    const suspended = transactionMock();
    suspended.user.findUnique.mockResolvedValue({
      id: userId,
      status: UserStatus.SUSPENDED,
    });
    await expect(
      serviceFor(suspended).service.completeAuthorization(callbackInput),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(suspended.authAccount.create).not.toHaveBeenCalled();

    const alreadyBound = transactionMock();
    alreadyBound.authAccount.findFirst.mockResolvedValue({
      id: 'other-google-account',
    });
    await expect(
      serviceFor(alreadyBound).service.completeAuthorization(callbackInput),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(alreadyBound.authAccount.create).not.toHaveBeenCalled();
  });

  it('uses serializable transactions and retries a concurrent binding race safely', async () => {
    const transaction = transactionMock();
    transaction.authAccount.findUnique.mockResolvedValueOnce({
      user: { id: userId, status: UserStatus.ACTIVE },
    });
    const { service, database } = serviceFor(transaction);
    vi.mocked(database.prisma.$transaction)
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce((callback) => callback(transaction));

    await service.completeAuthorization(callbackInput);

    expect(database.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(database.prisma.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
    expect(transaction.authAccount.create).not.toHaveBeenCalled();
  });
});
