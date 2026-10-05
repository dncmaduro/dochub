import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import {
  AuthProvider,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../admin/admin.service.js';
import { DatabaseService } from '../../database/database.service.js';
import type { AuthConfig } from '../auth.config.js';
import { AuthSessionService } from '../auth-session.service.js';
import type { GoogleCallbackInput } from './google-auth.service.js';
import { GoogleAuthService } from './google-auth.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;

withDatabase('GoogleAuthService self-registration integration', () => {
  const suffix = randomUUID();
  const emailPrefix = `selfreg-${suffix}`;
  const database = { prisma } as unknown as DatabaseService;
  const authConfig = {
    accessTokenSecret: 'google-auth-integration-secret',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
    refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    refreshCookieName: 'dochub_refresh',
    refreshCookieSecure: false,
    refreshCookieSameSite: 'lax',
    webOrigins: ['http://localhost:5173'],
  } as AuthConfig;
  const authSessions = new AuthSessionService(
    database,
    new JwtService({ secret: authConfig.accessTokenSecret }),
    authConfig,
  );
  const admin = new AdminService(database);
  let approverId: string;

  beforeAll(async () => {
    approverId = randomUUID();
    await prisma.user.create({
      data: {
        id: approverId,
        email: `${emailPrefix}-admin@example.test`,
        normalizedEmail: `${emailPrefix}-admin@example.test`,
        displayName: 'Integration administrator',
        status: UserStatus.ACTIVE,
        systemRole: SystemRole.ADMIN,
      },
    });
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { normalizedEmail: { startsWith: emailPrefix } },
      select: { id: true },
    });
    const ids = users.map((user) => user.id);
    if (ids.length) {
      await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  function serviceFor(input: {
    sub: string;
    email: string;
    email_verified?: boolean;
    name?: string;
  }) {
    return new GoogleAuthService(database, authSessions, {
      authorizationUrl: async () => 'https://accounts.google.com/',
      validateCallback: async () => ({
        sub: input.sub,
        email: input.email,
        email_verified: input.email_verified ?? true,
        name: input.name ?? 'Google Profile Name',
      }),
    });
  }

  function callbackInput(): GoogleCallbackInput {
    return {
      code: 'integration-code',
      state: 'integration-state',
      expectedState: 'integration-state',
      callbackParameters: new URLSearchParams({
        code: 'integration-code',
        state: 'integration-state',
      }),
      nonce: 'integration-nonce',
      codeVerifier: 'integration-code-verifier',
    };
  }

  async function createUser(
    email: string,
    status: UserStatus,
    systemRole = SystemRole.MEMBER,
  ) {
    return prisma.user.create({
      data: {
        email,
        normalizedEmail: email.toLowerCase(),
        displayName: email,
        status,
        systemRole,
      },
    });
  }

  it('creates one pending member, reuses it on repeat, then logs in after admin approval', async () => {
    const email = `${emailPrefix}-pending@example.test`;
    const sub = `${suffix}-pending-subject`;
    const service = serviceFor({
      sub,
      email: ` ${email.toUpperCase()} `,
      name: 'Trusted Google Name',
    });

    await expect(service.completeAuthorization(callbackInput())).resolves.toEqual({
      outcome: 'pending_approval',
    });
    let user = await prisma.user.findUniqueOrThrow({
      where: { normalizedEmail: email },
      include: { authAccounts: true },
    });
    expect(user).toMatchObject({
      email: email,
      normalizedEmail: email,
      displayName: 'Trusted Google Name',
      status: UserStatus.PENDING_APPROVAL,
      systemRole: SystemRole.MEMBER,
      authAccounts: [
        {
          provider: AuthProvider.GOOGLE,
          providerAccountId: sub,
        },
      ],
    });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.permissionEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.groupMember.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: user.id, action: 'USER_ACCESS_REQUESTED' },
      }),
    ).toBe(1);
    expect(
      (await admin.listUsers({ status: UserStatus.PENDING_APPROVAL, q: email }))
        .items,
    ).toContainEqual(expect.objectContaining({ id: user.id }));

    await expect(service.completeAuthorization(callbackInput())).resolves.toEqual({
      outcome: 'pending_approval',
    });
    user = await prisma.user.findUniqueOrThrow({
      where: { normalizedEmail: email },
      include: { authAccounts: true },
    });
    expect(await prisma.user.count({ where: { normalizedEmail: email } })).toBe(1);
    expect(user.authAccounts).toHaveLength(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const sessionsBeforeApproval = await prisma.session.count({
      where: { userId: user.id },
    });
    await expect(admin.approveUser(approverId, user.id)).resolves.toMatchObject({
      status: UserStatus.ACTIVE,
      systemRole: SystemRole.MEMBER,
    });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
      sessionsBeforeApproval,
    );
    expect(await prisma.permissionEntry.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.groupMember.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { resourceId: user.id, action: 'USER_APPROVED' },
      }),
    ).toBe(1);

    await expect(service.completeAuthorization(callbackInput())).resolves.toMatchObject({
      outcome: 'authenticated',
      tokens: { accessToken: expect.any(String), refreshToken: expect.any(String) },
    });
    expect(await prisma.user.count({ where: { normalizedEmail: email } })).toBe(1);
    expect(
      await prisma.authAccount.count({
        where: {
          provider: AuthProvider.GOOGLE,
          providerAccountId: sub,
          userId: user.id,
        },
      }),
    ).toBe(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it('keeps the INVITED first-login activation flow and gives ACTIVE users normal sessions', async () => {
    const invitedEmail = `${emailPrefix}-invited@example.test`;
    const invited = await createUser(invitedEmail, UserStatus.INVITED);
    const invitedLogin = await serviceFor({
      sub: `${suffix}-invited-subject`,
      email: invitedEmail,
    }).completeAuthorization(callbackInput());
    expect(invitedLogin.outcome).toBe('authenticated');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: invited.id } })).status,
    ).toBe(UserStatus.ACTIVE);
    expect(await prisma.session.count({ where: { userId: invited.id } })).toBe(1);

    const activeEmail = `${emailPrefix}-active@example.test`;
    const active = await createUser(activeEmail, UserStatus.ACTIVE);
    const activeLogin = await serviceFor({
      sub: `${suffix}-active-subject`,
      email: activeEmail,
    }).completeAuthorization(callbackInput());
    expect(activeLogin.outcome).toBe('authenticated');
    expect(await prisma.session.count({ where: { userId: active.id } })).toBe(1);
  });

  it('denies suspended accounts and rejects unverified email without creating a user', async () => {
    const suspendedEmail = `${emailPrefix}-suspended@example.test`;
    const suspended = await createUser(suspendedEmail, UserStatus.SUSPENDED);
    const sub = `${suffix}-suspended-subject`;
    await prisma.authAccount.create({
      data: {
        userId: suspended.id,
        provider: AuthProvider.GOOGLE,
        providerAccountId: sub,
      },
    });
    await expect(
      serviceFor({ sub, email: suspendedEmail }).completeAuthorization(
        callbackInput(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: suspended.id } })).status,
    ).toBe(UserStatus.SUSPENDED);
    expect(await prisma.session.count({ where: { userId: suspended.id } })).toBe(0);

    const unverifiedEmail = `${emailPrefix}-unverified@example.test`;
    await expect(
      serviceFor({
        sub: `${suffix}-unverified-subject`,
        email: unverifiedEmail,
        email_verified: false,
      }).completeAuthorization(callbackInput()),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await prisma.user.count({ where: { normalizedEmail: unverifiedEmail } }),
    ).toBe(0);
  });

  it('handles concurrent first login with one user and one Google account', async () => {
    const email = `${emailPrefix}-concurrent@example.test`;
    const sub = `${suffix}-concurrent-subject`;
    const service = serviceFor({ sub, email });

    const results = await Promise.all([
      service.completeAuthorization(callbackInput()),
      service.completeAuthorization(callbackInput()),
    ]);

    expect(results).toEqual([
      { outcome: 'pending_approval' },
      { outcome: 'pending_approval' },
    ]);
    const user = await prisma.user.findUniqueOrThrow({
      where: { normalizedEmail: email },
      include: { authAccounts: true },
    });
    expect(user.status).toBe(UserStatus.PENDING_APPROVAL);
    expect(user.authAccounts).toHaveLength(1);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });
});
