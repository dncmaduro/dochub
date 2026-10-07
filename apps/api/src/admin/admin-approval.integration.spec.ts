import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenGuard } from '../auth/access-token.guard.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth/auth.config.js';
import { AuthSessionService } from '../auth/auth-session.service.js';
import { DatabaseService } from '../database/database.service.js';
import { SystemAdminGuard } from '../common/system-admin.guard.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminService } from './admin.service.js';

const withDatabase = process.env.DATABASE_URL ? describe : describe.skip;

withDatabase('Admin approval endpoint integration', () => {
  let app: INestApplication<App>;
  let authSessions: AuthSessionService;
  const suffix = randomUUID();
  const emailPrefix = `admin-approval-${suffix}`;
  const memberId = randomUUID();
  const adminId = randomUUID();
  const pendingId = randomUUID();
  const database = { prisma } as unknown as DatabaseService;
  const config = {
    accessTokenSecret: `admin-approval-${suffix}-secret`,
    accessTokenTtlSeconds: 900,
    refreshTokenTtlDays: 30,
    refreshTokenLifetimeMs: 30 * 24 * 60 * 60 * 1000,
    refreshCookieName: 'dochub_refresh',
    refreshCookieSecure: false,
    refreshCookieSameSite: 'lax',
    webOrigins: ['http://localhost:5173'],
  } as AuthConfig;
  const jwt = new JwtService({ secret: config.accessTokenSecret });

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: memberId,
          email: `${emailPrefix}-member@example.test`,
          normalizedEmail: `${emailPrefix}-member@example.test`,
          displayName: 'Member',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.DOCUMENT_MANAGER,
        },
        {
          id: adminId,
          email: `${emailPrefix}-admin@example.test`,
          normalizedEmail: `${emailPrefix}-admin@example.test`,
          displayName: 'Administrator',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
        {
          id: pendingId,
          email: `${emailPrefix}-pending@example.test`,
          normalizedEmail: `${emailPrefix}-pending@example.test`,
          displayName: 'Pending user',
          status: UserStatus.PENDING_APPROVAL,
          systemRole: SystemRole.VIEWER,
        },
      ],
    });

    authSessions = new AuthSessionService(database, jwt, config);
    const module = await Test.createTestingModule({
      controllers: [AdminUsersController],
      providers: [
        AdminService,
        AccessTokenGuard,
        SystemAdminGuard,
        { provide: AuthSessionService, useValue: authSessions },
        { provide: DatabaseService, useValue: database },
        { provide: JwtService, useValue: jwt },
        { provide: AUTH_CONFIG, useValue: config },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    const ids = [memberId, adminId, pendingId];
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it('requires an active ADMIN and approval grants no session or document rights', async () => {
    const memberTokens = await authSessions.createSession({ userId: memberId });
    const adminTokens = await authSessions.createSession({ userId: adminId });

    await request(app.getHttpServer())
      .post(`/admin/users/${pendingId}/approve`)
      .set('Authorization', `Bearer ${memberTokens.accessToken}`)
      .expect(403);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: pendingId } })).status,
    ).toBe(UserStatus.PENDING_APPROVAL);

    const response = await request(app.getHttpServer())
      .post(`/admin/users/${pendingId}/approve`)
      .set('Authorization', `Bearer ${adminTokens.accessToken}`)
      .expect(201);
    expect(response.body).toMatchObject({
      id: pendingId,
      status: UserStatus.ACTIVE,
      systemRole: SystemRole.VIEWER,
    });
    expect(await prisma.session.count({ where: { userId: pendingId } })).toBe(0);
    expect(await prisma.permissionEntry.count({ where: { userId: pendingId } })).toBe(0);
    expect(await prisma.groupMember.count({ where: { userId: pendingId } })).toBe(0);
  });
});
