import { ConflictException, NotFoundException } from '@nestjs/common';
import { SystemRole, UserStatus } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseService } from '../database/database.service.js';
import { AdminService } from './admin.service.js';

const actorId = '6f874294-33cc-4d34-bd9a-8db60cc2a6d4';
const userId = 'b2b4a4ce-90cd-4f99-9cbb-d2c6e2d3d635';
const groupId = '536b63b5-9b67-4ea5-bdc3-9d6ca1c85ccf';
const now = new Date('2026-09-19T00:00:00.000Z');

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    email: 'member@example.test',
    displayName: 'Member',
    status: UserStatus.INVITED,
    systemRole: SystemRole.MEMBER,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: groupId,
    name: 'Operations',
    description: null,
    createdAt: now,
    updatedAt: now,
    _count: { members: 0 },
    ...overrides,
  };
}

function serviceFor(transaction: Record<string, unknown>) {
  const database = {
    prisma: {
      $transaction: vi.fn((callback) => callback(transaction)),
      user: { findMany: vi.fn(), findUnique: vi.fn() },
      group: { findMany: vi.fn(), findUnique: vi.fn() },
      groupMember: { findMany: vi.fn() },
    },
  } as unknown as DatabaseService;
  return { service: new AdminService(database), database };
}

function transactionMock() {
  return {
    user: {
      create: vi.fn().mockResolvedValue(user()),
      findUnique: vi.fn().mockResolvedValue(user()),
      update: vi.fn().mockResolvedValue(user()),
    },
    group: {
      create: vi.fn().mockResolvedValue(group()),
      findUnique: vi.fn().mockResolvedValue(group()),
      update: vi.fn().mockResolvedValue(group()),
    },
    groupMember: {
      create: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
}

describe('AdminService user mutations', () => {
  it('creates an INVITED user with conservative normalized email and transactional audit', async () => {
    const transaction = transactionMock();
    const { service } = serviceFor(transaction);

    await service.createUser(actorId, {
      email: ' Member@Example.test ',
      displayName: ' Member ',
      systemRole: SystemRole.ADMIN,
    });

    expect(transaction.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'Member@Example.test',
          normalizedEmail: 'member@example.test',
          displayName: 'Member',
          status: UserStatus.INVITED,
          systemRole: SystemRole.ADMIN,
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'USER_INVITED',
          actorId,
          result: 'SUCCESS',
        }),
      }),
    );
  });

  it('maps normalized-email uniqueness conflicts and protects an admin from self-lockout', async () => {
    const transaction = transactionMock();
    const { service, database } = serviceFor(transaction);
    vi.mocked(database.prisma.$transaction).mockRejectedValueOnce({
      code: 'P2002',
    });
    await expect(
      service.createUser(actorId, {
        email: 'member@example.test',
        displayName: 'Member',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    transaction.user.findUnique.mockResolvedValue(
      user({
        id: actorId,
        status: UserStatus.ACTIVE,
        systemRole: SystemRole.ADMIN,
      }),
    );
    await expect(
      service.updateUser(actorId, actorId, { systemRole: SystemRole.MEMBER }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.updateUser(actorId, actorId, { status: 'SUSPENDED' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates permitted fields with minimal change audit and cursor-paginates users', async () => {
    const transaction = transactionMock();
    transaction.user.findUnique.mockResolvedValue(
      user({ status: UserStatus.ACTIVE }),
    );
    transaction.user.update.mockResolvedValue(
      user({ displayName: 'Updated', status: UserStatus.ACTIVE }),
    );
    const { service, database } = serviceFor(transaction);

    await service.updateUser(actorId, userId, { displayName: 'Updated' });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'USER_UPDATED' }),
      }),
    );

    database.prisma.user.findMany = vi
      .fn()
      .mockResolvedValue([
        user({ id: actorId, createdAt: new Date('2026-09-20T00:00:00.000Z') }),
        user({ id: userId, createdAt: now }),
      ]);
    const page = await service.listUsers({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf('string');
  });
});

describe('AdminService groups and membership', () => {
  it('creates and updates a group with normalized-name conflict mapping and audit', async () => {
    const transaction = transactionMock();
    const { service, database } = serviceFor(transaction);

    await service.createGroup(actorId, { name: '  Operations   Team ' });
    expect(transaction.group.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Operations Team',
          normalizedName: 'operations team',
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'GROUP_CREATED' }),
      }),
    );

    vi.mocked(database.prisma.$transaction).mockRejectedValueOnce({
      code: 'P2002',
    });
    await expect(
      service.createGroup(actorId, { name: 'operations team' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds, paginates, and idempotently removes membership with audit writes', async () => {
    const transaction = transactionMock();
    const { service, database } = serviceFor(transaction);

    await service.addMember(actorId, groupId, { userId });
    expect(transaction.groupMember.create).toHaveBeenCalledWith({
      data: { groupId, userId, addedById: actorId },
    });
    expect(transaction.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'GROUP_MEMBER_ADDED' }),
      }),
    );

    database.prisma.group.findUnique = vi
      .fn()
      .mockResolvedValue({ id: groupId });
    database.prisma.groupMember.findMany = vi
      .fn()
      .mockResolvedValue([
        {
          createdAt: now,
          userId,
          user: user({ status: UserStatus.SUSPENDED }),
        },
      ]);
    const page = await service.listMembers(groupId, { limit: 20 });
    expect(page.items[0].user.status).toBe(UserStatus.SUSPENDED);

    transaction.groupMember.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      service.removeMember(actorId, groupId, userId),
    ).resolves.toBeUndefined();
    expect(transaction.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('does not hide unknown resources behind membership mutation', async () => {
    const transaction = transactionMock();
    transaction.group.findUnique.mockResolvedValue(null);
    const { service } = serviceFor(transaction);

    await expect(
      service.addMember(actorId, groupId, { userId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
