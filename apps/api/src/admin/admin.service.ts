import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  AuthProvider,
  Prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { normalizeEmail, normalizeGroupName } from '../common/normalization.js';
import {
  AddGroupMemberDto,
  CreateGroupDto,
  CreateUserDto,
  CursorPaginationDto,
  ListUsersQueryDto,
  UpdateGroupDto,
  UpdateUserDto,
} from './dto/admin.dto.js';
import {
  decodeCreatedAtCursor,
  decodeGroupMemberCursor,
  encodeCursor,
} from './admin-pagination.js';
import type {
  AdminGroupMemberResponse,
  AdminGroupResponse,
  AdminUserResponse,
  CursorPage,
} from './admin.types.js';

const DEFAULT_LIMIT = 20;

const userSelect = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  systemRole: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AdminService {
  constructor(private readonly database: DatabaseService) {}

  async createUser(
    actorUserId: string,
    dto: CreateUserDto,
  ): Promise<AdminUserResponse> {
    const email = dto.email.trim();
    const normalizedEmail = normalizeEmail(dto.email);
    const displayName = dto.displayName.trim();
    const systemRole = dto.systemRole ?? SystemRole.MEMBER;

    try {
      const user = await this.database.prisma.$transaction(
        async (transaction) => {
          const created = await transaction.user.create({
            data: {
              email,
              normalizedEmail,
              displayName,
              status: UserStatus.INVITED,
              systemRole,
            },
            select: userSelect,
          });
          await this.writeAudit(transaction, {
            actorUserId,
            action: 'USER_INVITED',
            resourceType: 'USER',
            resourceId: created.id,
            metadata: { systemRole },
          });
          return created;
        },
      );
      return this.userResponse(user);
    } catch (error) {
      this.throwConflictForUnique(
        error,
        'A user with this email already exists',
      );
      throw error;
    }
  }

  async listUsers(
    query: ListUsersQueryDto,
  ): Promise<CursorPage<AdminUserResponse>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = decodeCreatedAtCursor(query.cursor);
    const q = query.q?.trim();
    const searchFilter: Prisma.UserWhereInput | undefined = q
      ? {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { displayName: { contains: q, mode: 'insensitive' } },
          ],
        }
      : undefined;
    const cursorFilter: Prisma.UserWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            {
              createdAt: new Date(cursor.createdAt),
              id: { lt: cursor.id },
            },
          ],
        }
      : undefined;
    const conditions: Prisma.UserWhereInput[] = [
      ...(query.status ? [{ status: query.status }] : []),
      ...(query.systemRole ? [{ systemRole: query.systemRole }] : []),
      ...(searchFilter ? [searchFilter] : []),
      ...(cursorFilter ? [cursorFilter] : []),
    ];
    const where: Prisma.UserWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};
    const users = await this.database.prisma.user.findMany({
      where,
      select: userSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.createdAtPage(users, limit, (user) => this.userResponse(user));
  }

  async getUser(userId: string): Promise<AdminUserResponse> {
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...userSelect,
        authAccounts: {
          where: { provider: AuthProvider.GOOGLE },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      ...this.userResponse(user),
      googleConnected: user.authAccounts.length > 0,
    };
  }

  async updateUser(
    actorUserId: string,
    userId: string,
    dto: UpdateUserDto,
  ): Promise<AdminUserResponse> {
    const user = await this.database.prisma.$transaction(
      async (transaction) => {
        const current = await transaction.user.findUnique({
          where: { id: userId },
          select: userSelect,
        });
        if (!current) {
          throw new NotFoundException('User not found');
        }
        if (
          actorUserId === userId &&
          ((current.systemRole === SystemRole.ADMIN &&
            dto.systemRole === SystemRole.MEMBER) ||
            (current.status === UserStatus.ACTIVE &&
              dto.status === UserStatus.SUSPENDED))
        ) {
          throw new ConflictException(
            'Administrators cannot remove their own administrative access',
          );
        }

        const data: Prisma.UserUpdateInput = {};
        const changes: {
          displayName?: { from: string; to: string };
          systemRole?: { from: SystemRole; to: SystemRole };
          status?: { from: UserStatus; to: UserStatus };
        } = {};
        if (
          dto.displayName !== undefined &&
          dto.displayName.trim() !== current.displayName
        ) {
          data.displayName = dto.displayName.trim();
          changes.displayName = {
            from: current.displayName,
            to: dto.displayName.trim(),
          };
        }
        if (
          dto.systemRole !== undefined &&
          dto.systemRole !== current.systemRole
        ) {
          data.systemRole = dto.systemRole;
          changes.systemRole = { from: current.systemRole, to: dto.systemRole };
        }
        if (dto.status !== undefined && dto.status !== current.status) {
          data.status = dto.status;
          changes.status = { from: current.status, to: dto.status };
        }

        if (Object.keys(data).length === 0) {
          return current;
        }
        const updated = await transaction.user.update({
          where: { id: userId },
          data,
          select: userSelect,
        });
        await this.writeAudit(transaction, {
          actorUserId,
          action: 'USER_UPDATED',
          resourceType: 'USER',
          resourceId: userId,
          metadata: { changes },
        });
        return updated;
      },
    );
    return this.userResponse(user);
  }

  async createGroup(
    actorUserId: string,
    dto: CreateGroupDto,
  ): Promise<AdminGroupResponse> {
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const normalizedName = normalizeGroupName(dto.name);
    try {
      const group = await this.database.prisma.$transaction(
        async (transaction) => {
          const created = await transaction.group.create({
            data: {
              name,
              normalizedName,
              description: dto.description,
              createdById: actorUserId,
            },
            select: this.groupSelect(),
          });
          await this.writeAudit(transaction, {
            actorUserId,
            action: 'GROUP_CREATED',
            resourceType: 'GROUP',
            resourceId: created.id,
            metadata: {},
          });
          return created;
        },
      );
      return this.groupResponse(group);
    } catch (error) {
      this.throwConflictForUnique(
        error,
        'A group with this name already exists',
      );
      throw error;
    }
  }

  async listGroups(
    query: CursorPaginationDto,
  ): Promise<CursorPage<AdminGroupResponse>> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = decodeCreatedAtCursor(query.cursor);
    const groups = await this.database.prisma.group.findMany({
      where: cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : undefined,
      select: this.groupSelect(),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    return this.createdAtPage(groups, limit, (group) =>
      this.groupResponse(group),
    );
  }

  async getGroup(groupId: string): Promise<AdminGroupResponse> {
    const group = await this.database.prisma.group.findUnique({
      where: { id: groupId },
      select: this.groupSelect(),
    });
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return this.groupResponse(group);
  }

  async updateGroup(
    actorUserId: string,
    groupId: string,
    dto: UpdateGroupDto,
  ): Promise<AdminGroupResponse> {
    try {
      const group = await this.database.prisma.$transaction(
        async (transaction) => {
          const current = await transaction.group.findUnique({
            where: { id: groupId },
            select: this.groupSelect(),
          });
          if (!current) {
            throw new NotFoundException('Group not found');
          }

          const data: Prisma.GroupUpdateInput = {};
          const changes: {
            name?: { from: string; to: string };
            description?: { from: string | null; to: string | null };
          } = {};
          if (dto.name !== undefined) {
            const name = dto.name.trim().replace(/\s+/g, ' ');
            if (name !== current.name) {
              data.name = name;
              data.normalizedName = normalizeGroupName(dto.name);
              changes.name = { from: current.name, to: name };
            }
          }
          if (
            dto.description !== undefined &&
            dto.description !== current.description
          ) {
            data.description = dto.description;
            changes.description = {
              from: current.description,
              to: dto.description,
            };
          }
          if (Object.keys(data).length === 0) {
            return current;
          }

          const updated = await transaction.group.update({
            where: { id: groupId },
            data,
            select: this.groupSelect(),
          });
          await this.writeAudit(transaction, {
            actorUserId,
            action: 'GROUP_UPDATED',
            resourceType: 'GROUP',
            resourceId: groupId,
            metadata: { changes },
          });
          return updated;
        },
      );
      return this.groupResponse(group);
    } catch (error) {
      this.throwConflictForUnique(
        error,
        'A group with this name already exists',
      );
      throw error;
    }
  }

  async listMembers(
    groupId: string,
    query: CursorPaginationDto,
  ): Promise<CursorPage<AdminGroupMemberResponse>> {
    const group = await this.database.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    const limit = query.limit ?? DEFAULT_LIMIT;
    const cursor = decodeGroupMemberCursor(query.cursor);
    const members = await this.database.prisma.groupMember.findMany({
      where: {
        groupId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  userId: { lt: cursor.userId },
                },
              ],
            }
          : {}),
      },
      select: { createdAt: true, userId: true, user: { select: userSelect } },
      orderBy: [{ createdAt: 'desc' }, { userId: 'desc' }],
      take: limit + 1,
    });
    const page = members.slice(0, limit);
    const finalMember = page.at(-1);
    return {
      items: page.map((member) => ({
        user: this.userResponse(member.user),
        addedAt: member.createdAt,
      })),
      nextCursor:
        members.length > limit && finalMember
          ? encodeCursor({
              createdAt: finalMember.createdAt.toISOString(),
              userId: finalMember.userId,
            })
          : null,
    };
  }

  async addMember(
    actorUserId: string,
    groupId: string,
    dto: AddGroupMemberDto,
  ): Promise<void> {
    try {
      await this.database.prisma.$transaction(async (transaction) => {
        const [group, user] = await Promise.all([
          transaction.group.findUnique({
            where: { id: groupId },
            select: { id: true },
          }),
          transaction.user.findUnique({
            where: { id: dto.userId },
            select: { id: true },
          }),
        ]);
        if (!group) {
          throw new NotFoundException('Group not found');
        }
        if (!user) {
          throw new NotFoundException('User not found');
        }
        await transaction.groupMember.create({
          data: { groupId, userId: dto.userId, addedById: actorUserId },
        });
        await this.writeAudit(transaction, {
          actorUserId,
          action: 'GROUP_MEMBER_ADDED',
          resourceType: 'GROUP',
          resourceId: groupId,
          metadata: { userId: dto.userId },
        });
      });
    } catch (error) {
      this.throwConflictForUnique(error, 'User is already a group member');
      throw error;
    }
  }

  async removeMember(
    actorUserId: string,
    groupId: string,
    userId: string,
  ): Promise<void> {
    await this.database.prisma.$transaction(async (transaction) => {
      const group = await transaction.group.findUnique({
        where: { id: groupId },
        select: { id: true },
      });
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      const removed = await transaction.groupMember.deleteMany({
        where: { groupId, userId },
      });
      if (removed.count === 0) {
        return;
      }
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'GROUP_MEMBER_REMOVED',
        resourceType: 'GROUP',
        resourceId: groupId,
        metadata: { userId },
      });
    });
  }

  private groupSelect() {
    return {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { members: true } },
    } satisfies Prisma.GroupSelect;
  }

  private userResponse(
    user: Prisma.UserGetPayload<{ select: typeof userSelect }>,
  ): AdminUserResponse {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      systemRole: user.systemRole,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private groupResponse(
    group: Prisma.GroupGetPayload<{
      select: ReturnType<AdminService['groupSelect']>;
    }>,
  ): AdminGroupResponse {
    return {
      id: group.id,
      name: group.name,
      description: group.description,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      memberCount: group._count.members,
    };
  }

  private createdAtPage<T extends { id: string; createdAt: Date }, R>(
    records: T[],
    limit: number,
    map: (record: T) => R,
  ): CursorPage<R> {
    const page = records.slice(0, limit);
    const finalRecord = page.at(-1);
    return {
      items: page.map(map),
      nextCursor:
        records.length > limit && finalRecord
          ? encodeCursor({
              createdAt: finalRecord.createdAt.toISOString(),
              id: finalRecord.id,
            })
          : null,
    };
  }

  private async writeAudit(
    transaction: Prisma.TransactionClient,
    input: {
      actorUserId: string;
      action: string;
      resourceType: string;
      resourceId: string;
      metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        result: AuditResult.SUCCESS,
        metadata: input.metadata,
      },
    });
  }

  private throwConflictForUnique(error: unknown, message: string): void {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }
  }
}
