import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { SystemRole, UserStatus } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { SystemAdminGuard } from './system-admin.guard.js';

function contextFor(auth?: { userId: string }) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as never;
}

describe('SystemAdminGuard', () => {
  it('rejects unauthenticated, MEMBER, and suspended identities', async () => {
    const database = {
      prisma: { user: { findUnique: vi.fn() } },
    } as unknown as DatabaseService;
    const guard = new SystemAdminGuard(database);

    await expect(guard.canActivate(contextFor())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    database.prisma.user.findUnique = vi.fn().mockResolvedValue({
      status: UserStatus.ACTIVE,
      systemRole: SystemRole.MEMBER,
    });
    await expect(
      guard.canActivate(contextFor({ userId: 'user-id' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    database.prisma.user.findUnique = vi.fn().mockResolvedValue({
      status: UserStatus.SUSPENDED,
      systemRole: SystemRole.ADMIN,
    });
    await expect(
      guard.canActivate(contextFor({ userId: 'user-id' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an ACTIVE current ADMIN role loaded from PostgreSQL', async () => {
    const database = {
      prisma: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            status: UserStatus.ACTIVE,
            systemRole: SystemRole.ADMIN,
          }),
        },
      },
    } as unknown as DatabaseService;

    await expect(
      new SystemAdminGuard(database).canActivate(
        contextFor({ userId: 'user-id' }),
      ),
    ).resolves.toBe(true);
  });
});
