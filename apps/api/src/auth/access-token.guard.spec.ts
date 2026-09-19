import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from './access-token.guard.js';
import { AuthSessionService } from './auth-session.service.js';

const secret = 'guard-test-secret';
const userId = '6f874294-33cc-4d34-bd9a-8db60cc2a6d4';
const sessionId = 'b2b4a4ce-90cd-4f99-9cbb-d2c6e2d3d635';

function executionContext(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AccessTokenGuard', () => {
  it('accepts a valid token with an active session and attaches a minimal principal', async () => {
    const jwt = new JwtService({ secret });
    const sessions = {
      validateAccessSession: vi.fn().mockResolvedValue({ userId, sessionId }),
    } as unknown as AuthSessionService;
    const guard = new AccessTokenGuard(jwt, sessions);
    const token = await jwt.signAsync({
      sub: userId,
      sid: sessionId,
      typ: 'access',
    });
    const request = {
      headers: { authorization: `Bearer ${token}` },
    } as AuthenticatedRequest;

    await expect(guard.canActivate(executionContext(request))).resolves.toBe(
      true,
    );
    expect(request.auth).toEqual({ userId, sessionId });
  });

  it('rejects invalid, expired, and wrong-type JWTs before trusting a principal', async () => {
    const jwt = new JwtService({ secret });
    const sessions = {
      validateAccessSession: vi.fn(),
    } as unknown as AuthSessionService;
    const guard = new AccessTokenGuard(jwt, sessions);
    const expired = await jwt.signAsync(
      { sub: userId, sid: sessionId, typ: 'access' },
      { expiresIn: -1 },
    );
    const wrongType = await jwt.signAsync({
      sub: userId,
      sid: sessionId,
      typ: 'refresh',
    });

    for (const token of ['not-a-jwt', expired, wrongType]) {
      const request = {
        headers: { authorization: `Bearer ${token}` },
      } as AuthenticatedRequest;
      await expect(
        guard.canActivate(executionContext(request)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(sessions.validateAccessSession).not.toHaveBeenCalled();
  });

  it.each(['revoked session', 'mismatched sub/sid', 'suspended user'])(
    'rejects when session validation reports a %s',
    async () => {
      const jwt = new JwtService({ secret });
      const sessions = {
        validateAccessSession: vi
          .fn()
          .mockRejectedValue(new UnauthorizedException()),
      } as unknown as AuthSessionService;
      const guard = new AccessTokenGuard(jwt, sessions);
      const token = await jwt.signAsync({
        sub: userId,
        sid: sessionId,
        typ: 'access',
      });
      const request = {
        headers: { authorization: `Bearer ${token}` },
      } as AuthenticatedRequest;

      await expect(
        guard.canActivate(executionContext(request)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
});
