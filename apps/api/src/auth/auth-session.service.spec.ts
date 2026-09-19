import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@dochub/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import type { AuthConfig } from './auth.config.js';
import { AuthSessionService } from './auth-session.service.js';
import { generateRefreshToken, hashRefreshToken } from './refresh-token.js';

const userId = '6f874294-33cc-4d34-bd9a-8db60cc2a6d4';
const sessionId = 'b2b4a4ce-90cd-4f99-9cbb-d2c6e2d3d635';
const config: AuthConfig = {
  accessTokenSecret: 'unit-test-secret',
  accessTokenTtlSeconds: 900,
  refreshTokenTtlDays: 30,
  refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  refreshCookieName: 'dochub_refresh',
  refreshCookieSecure: false,
  refreshCookieSameSite: 'lax',
};

function activeUser(status: UserStatus = UserStatus.ACTIVE) {
  return { id: userId, status };
}

function databaseMock() {
  return {
    prisma: {
      user: { findUnique: vi.fn() },
      session: {
        create: vi.fn(),
        findMany: vi.fn(),
        updateMany: vi.fn(),
        findUnique: vi.fn(),
      },
    },
  } as unknown as DatabaseService;
}

describe('refresh-token helpers', () => {
  it('generates opaque tokens and hashes rather than storing raw values', () => {
    const rawToken = generateRefreshToken();

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(rawToken.length).toBeGreaterThanOrEqual(43);
    expect(hashRefreshToken(rawToken)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRefreshToken(rawToken)).not.toBe(rawToken);
  });
});

describe('AuthSessionService', () => {
  let database: DatabaseService;
  let service: AuthSessionService;

  beforeEach(() => {
    database = databaseMock();
    service = new AuthSessionService(
      database,
      new JwtService({
        secret: config.accessTokenSecret,
        signOptions: { expiresIn: config.accessTokenTtlSeconds },
      }),
      config,
    );
  });

  it('creates a session only for an ACTIVE user and persists a refresh-token hash', async () => {
    database.prisma.user.findUnique = vi.fn().mockResolvedValue(activeUser());
    database.prisma.session.create = vi
      .fn()
      .mockResolvedValue({ id: sessionId });

    const tokens = await service.createSession({
      userId,
      ipAddress: '127.0.0.1',
    });

    const createData = vi.mocked(database.prisma.session.create).mock
      .calls[0][0].data;
    expect(createData.refreshTokenHash).toBe(
      hashRefreshToken(tokens.refreshToken),
    );
    expect(createData.refreshTokenHash).not.toBe(tokens.refreshToken);
    expect(tokens.accessToken).toBeTypeOf('string');
    expect(tokens.expiresIn).toBe(900);
  });

  it.each([UserStatus.INVITED, UserStatus.SUSPENDED])(
    'rejects session creation for a %s user',
    async (status) => {
      database.prisma.user.findUnique = vi
        .fn()
        .mockResolvedValue(activeUser(status));

      await expect(service.createSession({ userId })).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(database.prisma.session.create).not.toHaveBeenCalled();
    },
  );

  it('rotates refresh tokens, invalidating the old value', async () => {
    const originalRefreshToken = 'original-refresh-token';
    let currentHash = hashRefreshToken(originalRefreshToken);
    database.prisma.session.findMany = vi.fn(({ where }) =>
      Promise.resolve(
        where.refreshTokenHash === currentHash
          ? [
              {
                id: sessionId,
                userId,
                expiresAt: new Date(Date.now() + 60_000),
                revokedAt: null,
                user: activeUser(),
              },
            ]
          : [],
      ),
    );
    database.prisma.session.updateMany = vi.fn(({ where, data }) => {
      if (where.refreshTokenHash !== currentHash) {
        return Promise.resolve({ count: 0 });
      }
      currentHash = data.refreshTokenHash;
      return Promise.resolve({ count: 1 });
    });

    const firstRotation = await service.refreshSession(originalRefreshToken);
    await expect(
      service.refreshSession(originalRefreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const secondRotation = await service.refreshSession(
      firstRotation.refreshToken,
    );

    expect(secondRotation.refreshToken).not.toBe(firstRotation.refreshToken);
    expect(vi.mocked(database.prisma.session.updateMany)).toHaveBeenCalledTimes(
      2,
    );
  });

  it.each([
    [
      'revoked',
      {
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        user: activeUser(),
      },
    ],
    [
      'expired',
      {
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
        user: activeUser(),
      },
    ],
    [
      'suspended user',
      {
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: activeUser(UserStatus.SUSPENDED),
      },
    ],
  ])('rejects refresh for a %s session', async (_scenario, state) => {
    database.prisma.session.findMany = vi
      .fn()
      .mockResolvedValue([{ id: sessionId, userId, ...state }]);

    await expect(
      service.refreshSession('refresh-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(database.prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('allows only one concurrent rotation of the same refresh token', async () => {
    database.prisma.session.findMany = vi.fn().mockResolvedValue([
      {
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        user: activeUser(),
      },
    ]);
    database.prisma.session.updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const results = await Promise.allSettled([
      service.refreshSession('same-refresh-token'),
      service.refreshSession('same-refresh-token'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('revokes sessions idempotently without deleting them', async () => {
    database.prisma.session.updateMany = vi
      .fn()
      .mockResolvedValue({ count: 1 });

    await service.revokeSession('refresh-token');
    database.prisma.session.updateMany = vi
      .fn()
      .mockResolvedValue({ count: 0 });
    await service.revokeSession('refresh-token');

    expect(database.prisma.session.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
  });

  it.each([
    [
      'mismatched session user',
      {
        userId: '536b63b5-9b67-4ea5-bdc3-9d6ca1c85ccf',
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        user: activeUser(),
      },
    ],
    [
      'revoked session',
      {
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: new Date(),
        user: activeUser(),
      },
    ],
    [
      'expired session',
      {
        userId,
        expiresAt: new Date(Date.now() - 60_000),
        revokedAt: null,
        user: activeUser(),
      },
    ],
    [
      'suspended user',
      {
        userId,
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
        user: activeUser(UserStatus.SUSPENDED),
      },
    ],
  ])('rejects access validation for a %s', async (_scenario, session) => {
    database.prisma.session.findUnique = vi.fn().mockResolvedValue({
      ...session,
    });

    await expect(
      service.validateAccessSession({ userId, sessionId }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
