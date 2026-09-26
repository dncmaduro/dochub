import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { OptionalAccessTokenGuard } from './optional-access-token.guard.js';

function context(
  headers: Record<string, string | undefined>,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('OptionalAccessTokenGuard', () => {
  it('continues anonymously only when credentials are absent', async () => {
    const access = { authenticateRequest: vi.fn() } as never;
    await expect(
      new OptionalAccessTokenGuard(access).canActivate(context({})),
    ).resolves.toBe(true);
    expect(access.authenticateRequest).not.toHaveBeenCalled();
  });

  it('uses normal authentication and never downgrades invalid credentials', async () => {
    const access = {
      authenticateRequest: vi
        .fn()
        .mockRejectedValue(new UnauthorizedException()),
    } as never;
    await expect(
      new OptionalAccessTokenGuard(access).canActivate(
        context({ authorization: 'Bearer invalid' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
