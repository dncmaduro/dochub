import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditResult,
  DocumentRole,
  Prisma,
} from '@dochub/database';
import {
  DocumentAuthorizationService,
  type DocumentAuthorizationClient,
} from '../authorization/document-authorization.service.js';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DatabaseService } from '../database/database.service.js';
import {
  SetPermissionRoleDto,
  UpdatePermissionSettingsDto,
} from './dto/permission.dto.js';
import type {
  NodePermissionsResponse,
  PermissionEntryResponse,
} from './permissions.types.js';

const SERIALIZATION_RETRIES = 3;

const permissionSelect = {
  id: true,
  userId: true,
  groupId: true,
  role: true,
  user: {
    select: { id: true, displayName: true, email: true, status: true },
  },
  group: { select: { id: true, name: true, description: true } },
} satisfies Prisma.PermissionEntrySelect;

type SelectedPermissionEntry = Prisma.PermissionEntryGetPayload<{
  select: typeof permissionSelect;
}>;

@Injectable()
export class PermissionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: DocumentAuthorizationService,
  ) {}

  async list(
    actorUserId: string,
    nodeId: string,
  ): Promise<NodePermissionsResponse> {
    const node = await this.requireManagePermission(actorUserId, nodeId);
    const entries = await this.database.prisma.permissionEntry.findMany({
      where: { nodeId },
      select: permissionSelect,
    });
    return {
      nodeId,
      inheritPermissions: node.inheritPermissions,
      entries: entries
        .map((entry) => this.permissionResponse(entry))
        .sort((left, right) => this.compareEntries(left, right)),
    };
  }

  async setUser(
    actorUserId: string,
    nodeId: string,
    userId: string,
    dto: SetPermissionRoleDto,
  ): Promise<PermissionEntryResponse> {
    return this.withSerializableRetry(async (transaction) => {
      await this.requireManagePermission(actorUserId, nodeId, transaction);
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      const existing = await transaction.permissionEntry.findUnique({
        where: { nodeId_userId: { nodeId, userId } },
        select: { id: true, role: true },
      });
      if (existing?.role === dto.role) {
        return this.requireUserPermissionResponse(transaction, nodeId, userId);
      }
      await transaction.permissionEntry.upsert({
        where: { nodeId_userId: { nodeId, userId } },
        create: { nodeId, userId, role: dto.role, createdById: actorUserId },
        update: { role: dto.role },
      });
      await this.assertPermissionMutationSafe(actorUserId, nodeId, transaction);
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'PERMISSION_USER_SET',
        nodeId,
        metadata: {
          principalType: 'USER',
          principalId: userId,
          beforeRole: existing?.role ?? null,
          afterRole: dto.role,
        },
      });
      return this.requireUserPermissionResponse(transaction, nodeId, userId);
    });
  }

  async setGroup(
    actorUserId: string,
    nodeId: string,
    groupId: string,
    dto: SetPermissionRoleDto,
  ): Promise<PermissionEntryResponse> {
    return this.withSerializableRetry(async (transaction) => {
      await this.requireManagePermission(actorUserId, nodeId, transaction);
      const group = await transaction.group.findUnique({
        where: { id: groupId },
        select: { id: true },
      });
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      const existing = await transaction.permissionEntry.findUnique({
        where: { nodeId_groupId: { nodeId, groupId } },
        select: { id: true, role: true },
      });
      if (existing?.role === dto.role) {
        return this.requireGroupPermissionResponse(
          transaction,
          nodeId,
          groupId,
        );
      }
      await transaction.permissionEntry.upsert({
        where: { nodeId_groupId: { nodeId, groupId } },
        create: { nodeId, groupId, role: dto.role, createdById: actorUserId },
        update: { role: dto.role },
      });
      await this.assertPermissionMutationSafe(actorUserId, nodeId, transaction);
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'PERMISSION_GROUP_SET',
        nodeId,
        metadata: {
          principalType: 'GROUP',
          principalId: groupId,
          beforeRole: existing?.role ?? null,
          afterRole: dto.role,
        },
      });
      return this.requireGroupPermissionResponse(transaction, nodeId, groupId);
    });
  }

  async removeUser(
    actorUserId: string,
    nodeId: string,
    userId: string,
  ): Promise<void> {
    await this.withSerializableRetry(async (transaction) => {
      await this.requireManagePermission(actorUserId, nodeId, transaction);
      const existing = await transaction.permissionEntry.findUnique({
        where: { nodeId_userId: { nodeId, userId } },
        select: { id: true, role: true },
      });
      if (!existing) {
        return;
      }
      await transaction.permissionEntry.delete({ where: { id: existing.id } });
      await this.assertPermissionMutationSafe(actorUserId, nodeId, transaction);
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'PERMISSION_USER_REMOVED',
        nodeId,
        metadata: {
          principalType: 'USER',
          principalId: userId,
          beforeRole: existing.role,
        },
      });
    });
  }

  async removeGroup(
    actorUserId: string,
    nodeId: string,
    groupId: string,
  ): Promise<void> {
    await this.withSerializableRetry(async (transaction) => {
      await this.requireManagePermission(actorUserId, nodeId, transaction);
      const existing = await transaction.permissionEntry.findUnique({
        where: { nodeId_groupId: { nodeId, groupId } },
        select: { id: true, role: true },
      });
      if (!existing) {
        return;
      }
      await transaction.permissionEntry.delete({ where: { id: existing.id } });
      await this.assertPermissionMutationSafe(actorUserId, nodeId, transaction);
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'PERMISSION_GROUP_REMOVED',
        nodeId,
        metadata: {
          principalType: 'GROUP',
          principalId: groupId,
          beforeRole: existing.role,
        },
      });
    });
  }

  async updateSettings(
    actorUserId: string,
    nodeId: string,
    dto: UpdatePermissionSettingsDto,
  ): Promise<{ nodeId: string; inheritPermissions: boolean }> {
    return this.withSerializableRetry(async (transaction) => {
      const node = await this.requireManagePermission(
        actorUserId,
        nodeId,
        transaction,
      );
      if (node.inheritPermissions === dto.inheritPermissions) {
        return { nodeId, inheritPermissions: node.inheritPermissions };
      }
      await transaction.node.update({
        where: { id: nodeId },
        data: {
          inheritPermissions: dto.inheritPermissions,
          updatedById: actorUserId,
        },
      });
      await this.assertPermissionMutationSafe(actorUserId, nodeId, transaction);
      await this.writeAudit(transaction, {
        actorUserId,
        action: 'PERMISSION_INHERITANCE_UPDATED',
        nodeId,
        metadata: {
          before: node.inheritPermissions,
          after: dto.inheritPermissions,
        },
      });
      return { nodeId, inheritPermissions: dto.inheritPermissions };
    });
  }

  private async requireManagePermission(
    actorUserId: string,
    nodeId: string,
    client: DocumentAuthorizationClient = this.database.prisma,
  ): Promise<{ inheritPermissions: boolean }> {
    const node = await client.node.findFirst({
      where: { id: nodeId, trashOperationId: null },
      select: { inheritPermissions: true },
    });
    if (!node) {
      throw new NotFoundException('Node not found');
    }
    const capabilities = await this.authorization.resolveCapabilities(
      actorUserId,
      nodeId,
      client,
    );
    if (!capabilities.capabilities.has(DocumentCapability.VIEW)) {
      throw new NotFoundException('Node not found');
    }
    if (!capabilities.capabilities.has(DocumentCapability.MANAGE_PERMISSION)) {
      throw new ForbiddenException(
        'You do not have permission to manage this node',
      );
    }
    return node;
  }

  private async assertPermissionMutationSafe(
    actorUserId: string,
    nodeId: string,
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    const owner = await transaction.permissionEntry.findFirst({
      where: { nodeId, role: DocumentRole.OWNER },
      select: { id: true },
    });
    if (!owner) {
      throw new ConflictException(
        'A node must retain at least one explicit owner',
      );
    }
    const effective = await this.authorization.resolveCapabilities(
      actorUserId,
      nodeId,
      transaction,
    );
    if (!effective.capabilities.has(DocumentCapability.MANAGE_PERMISSION)) {
      throw new ConflictException(
        'This change would remove your permission to manage the node',
      );
    }
  }

  private async requireUserPermissionResponse(
    transaction: Prisma.TransactionClient,
    nodeId: string,
    userId: string,
  ): Promise<PermissionEntryResponse> {
    const entry = await transaction.permissionEntry.findUniqueOrThrow({
      where: { nodeId_userId: { nodeId, userId } },
      select: permissionSelect,
    });
    return this.permissionResponse(entry);
  }

  private async requireGroupPermissionResponse(
    transaction: Prisma.TransactionClient,
    nodeId: string,
    groupId: string,
  ): Promise<PermissionEntryResponse> {
    const entry = await transaction.permissionEntry.findUniqueOrThrow({
      where: { nodeId_groupId: { nodeId, groupId } },
      select: permissionSelect,
    });
    return this.permissionResponse(entry);
  }

  private permissionResponse(
    entry: SelectedPermissionEntry,
  ): PermissionEntryResponse {
    if (entry.userId && entry.user) {
      return {
        id: entry.id,
        principalType: 'USER',
        principal: entry.user,
        role: entry.role,
      };
    }
    if (entry.groupId && entry.group) {
      return {
        id: entry.id,
        principalType: 'GROUP',
        principal: entry.group,
        role: entry.role,
      };
    }
    throw new ConflictException('Permission entry has no principal');
  }

  private compareEntries(
    left: PermissionEntryResponse,
    right: PermissionEntryResponse,
  ): number {
    const typeOrder = left.principalType.localeCompare(right.principalType);
    if (typeOrder !== 0) {
      return typeOrder;
    }
    const leftName =
      left.principalType === 'USER'
        ? left.principal.displayName
        : left.principal.name;
    const rightName =
      right.principalType === 'USER'
        ? right.principal.displayName
        : right.principal.name;
    return (
      leftName.localeCompare(rightName) ||
      left.principal.id.localeCompare(right.principal.id)
    );
  }

  private async writeAudit(
    transaction: Prisma.TransactionClient,
    input: {
      actorUserId: string;
      action:
        | 'PERMISSION_USER_SET'
        | 'PERMISSION_GROUP_SET'
        | 'PERMISSION_USER_REMOVED'
        | 'PERMISSION_GROUP_REMOVED'
        | 'PERMISSION_INHERITANCE_UPDATED';
      nodeId: string;
      metadata: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    await transaction.auditLog.create({
      data: {
        actorType: AuditActorType.USER,
        actorId: input.actorUserId,
        action: input.action,
        resourceType: 'NODE',
        resourceId: input.nodeId,
        result: AuditResult.SUCCESS,
        metadata: input.metadata,
      },
    });
  }

  private async withSerializableRetry<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < SERIALIZATION_RETRIES; attempt += 1) {
      try {
        return await this.database.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (!this.isSerializationConflict(error)) {
          throw error;
        }
        if (attempt + 1 === SERIALIZATION_RETRIES) {
          throw new ConflictException(
            'Permission change conflicted with another update',
          );
        }
      }
    }
    throw new ConflictException(
      'Permission change conflicted with another update',
    );
  }

  private isSerializationConflict(error: unknown): boolean {
    if (!error || typeof error !== 'object' || !('code' in error)) {
      return false;
    }
    if (error.code === 'P2034') {
      return true;
    }
    return (
      error.code === 'P2010' &&
      'meta' in error &&
      !!error.meta &&
      typeof error.meta === 'object' &&
      'code' in error.meta &&
      error.meta.code === '40001'
    );
  }
}
