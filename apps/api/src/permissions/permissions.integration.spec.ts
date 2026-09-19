import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DocumentRole,
  NodeType,
  prisma,
  SystemRole,
  UserStatus,
} from '@dochub/database';
import { DocumentAuthorizationService } from '../authorization/document-authorization.service.js';
import { DatabaseService } from '../database/database.service.js';
import { PermissionsService } from './permissions.service.js';

const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase('PermissionsService integration', () => {
  const suffix = randomUUID();
  const actorId = randomUUID();
  const ownerBId = randomUUID();
  const invitedId = randomUUID();
  const suspendedId = randomUUID();
  const systemAdminId = randomUUID();
  const groupId = randomUUID();
  const actorOwnerGroupId = randomUUID();
  const nodeIds = new Set<string>();
  const database = { prisma } as unknown as DatabaseService;
  const authorization = new DocumentAuthorizationService(database);
  const permissions = new PermissionsService(database, authorization);
  let nodeId: string;
  let inheritedNodeId: string;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          id: actorId,
          email: `permissions-actor-${suffix}@example.test`,
          normalizedEmail: `permissions-actor-${suffix}@example.test`,
          displayName: 'Permission actor',
          status: UserStatus.ACTIVE,
        },
        {
          id: ownerBId,
          email: `permissions-owner-b-${suffix}@example.test`,
          normalizedEmail: `permissions-owner-b-${suffix}@example.test`,
          displayName: 'Permission owner B',
          status: UserStatus.ACTIVE,
        },
        {
          id: invitedId,
          email: `permissions-invited-${suffix}@example.test`,
          normalizedEmail: `permissions-invited-${suffix}@example.test`,
          displayName: 'Invited principal',
          status: UserStatus.INVITED,
        },
        {
          id: suspendedId,
          email: `permissions-suspended-${suffix}@example.test`,
          normalizedEmail: `permissions-suspended-${suffix}@example.test`,
          displayName: 'Suspended principal',
          status: UserStatus.SUSPENDED,
        },
        {
          id: systemAdminId,
          email: `permissions-admin-${suffix}@example.test`,
          normalizedEmail: `permissions-admin-${suffix}@example.test`,
          displayName: 'System administrator',
          status: UserStatus.ACTIVE,
          systemRole: SystemRole.ADMIN,
        },
      ],
    });
    await prisma.group.createMany({
      data: [
        {
          id: groupId,
          name: `Permission anchor ${suffix}`,
          normalizedName: `permission anchor ${suffix}`,
          createdById: actorId,
        },
        {
          id: actorOwnerGroupId,
          name: `Actor owner ${suffix}`,
          normalizedName: `actor owner ${suffix}`,
          createdById: actorId,
        },
      ],
    });
    await prisma.groupMember.create({
      data: { groupId: actorOwnerGroupId, userId: actorId, addedById: actorId },
    });
    const root = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `permission-root-${suffix}`,
        normalizedName: `permission-root-${suffix}`,
        createdById: actorId,
      },
    });
    nodeIds.add(root.id);
    const node = await prisma.node.create({
      data: {
        parentId: root.id,
        type: NodeType.FOLDER,
        name: `permission-node-${suffix}`,
        normalizedName: `permission-node-${suffix}`,
        inheritPermissions: false,
        createdById: actorId,
      },
    });
    nodeId = node.id;
    nodeIds.add(node.id);
    const inheritedNode = await prisma.node.create({
      data: {
        parentId: root.id,
        type: NodeType.FOLDER,
        name: `inherited-node-${suffix}`,
        normalizedName: `inherited-node-${suffix}`,
        createdById: actorId,
      },
    });
    inheritedNodeId = inheritedNode.id;
    nodeIds.add(inheritedNode.id);
    await prisma.permissionEntry.createMany({
      data: [
        { nodeId: root.id, userId: actorId, role: DocumentRole.OWNER },
        { nodeId: node.id, userId: actorId, role: DocumentRole.OWNER },
        { nodeId: inheritedNode.id, groupId, role: DocumentRole.OWNER },
      ],
    });
  });

  afterAll(async () => {
    const ids = [...nodeIds];
    await prisma.auditLog.deleteMany({ where: { resourceId: { in: ids } } });
    await prisma.permissionEntry.deleteMany({ where: { nodeId: { in: ids } } });
    const existingNodes = await prisma.node.findMany({
      where: { id: { in: ids } },
      select: { id: true, parentId: true },
    });
    const parents = new Map(
      existingNodes.map((node) => [node.id, node.parentId]),
    );
    const depth = (id: string): number => {
      const parentId = parents.get(id);
      return parentId && parents.has(parentId) ? depth(parentId) + 1 : 0;
    };
    for (const node of [...existingNodes].sort(
      (left, right) => depth(right.id) - depth(left.id),
    )) {
      await prisma.node.deleteMany({ where: { id: node.id } });
    }
    await prisma.groupMember.deleteMany({
      where: { groupId: { in: [groupId, actorOwnerGroupId] } },
    });
    await prisma.group.deleteMany({
      where: { id: { in: [groupId, actorOwnerGroupId] } },
    });
    await prisma.user.deleteMany({
      where: {
        id: { in: [actorId, ownerBId, invitedId, suspendedId, systemAdminId] },
      },
    });
    await prisma.$disconnect();
  });

  it('lists only this node’s explicit ACLs and requires MANAGE_PERMISSION', async () => {
    const listed = await permissions.list(actorId, nodeId);
    expect(listed.nodeId).toBe(nodeId);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]).toMatchObject({
      principalType: 'USER',
      principal: { id: actorId, displayName: 'Permission actor' },
      role: DocumentRole.OWNER,
    });
    expect(listed.entries[0].principal).not.toHaveProperty('normalizedEmail');
    await expect(permissions.list(ownerBId, nodeId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(permissions.list(systemAdminId, nodeId)).rejects.toMatchObject(
      {
        status: 404,
      },
    );
  });

  it('upserts user and group entries without copying group ACLs to members', async () => {
    const userSet = await permissions.setUser(actorId, nodeId, invitedId, {
      role: DocumentRole.VIEWER,
    });
    expect(userSet).toMatchObject({
      principalType: 'USER',
      role: DocumentRole.VIEWER,
    });
    const updated = await permissions.setUser(actorId, nodeId, invitedId, {
      role: DocumentRole.EDITOR,
    });
    expect(updated).toMatchObject({ role: DocumentRole.EDITOR });
    await permissions.setUser(actorId, nodeId, suspendedId, {
      role: DocumentRole.VIEWER,
    });
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId, userId: invitedId },
      }),
    ).toBe(1);

    const groupSet = await permissions.setGroup(
      actorId,
      nodeId,
      actorOwnerGroupId,
      {
        role: DocumentRole.VIEWER,
      },
    );
    expect(groupSet).toMatchObject({
      principalType: 'GROUP',
      role: DocumentRole.VIEWER,
    });
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId, userId: actorId },
      }),
    ).toBe(1);
    await expect(
      permissions.setUser(actorId, nodeId, randomUUID(), {
        role: DocumentRole.VIEWER,
      }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      permissions.setGroup(actorId, nodeId, randomUUID(), {
        role: DocumentRole.VIEWER,
      }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('removes only direct rows idempotently and records mutation audits', async () => {
    await permissions.removeUser(actorId, nodeId, invitedId);
    await permissions.removeUser(actorId, nodeId, invitedId);
    await permissions.removeGroup(actorId, nodeId, actorOwnerGroupId);
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId, userId: invitedId },
      }),
    ).toBe(0);
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId, groupId: actorOwnerGroupId },
      }),
    ).toBe(0);
    const actions = await prisma.auditLog.findMany({
      where: { resourceId: nodeId },
      select: { action: true },
    });
    expect(actions.map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        'PERMISSION_USER_SET',
        'PERMISSION_GROUP_SET',
        'PERMISSION_USER_REMOVED',
        'PERMISSION_GROUP_REMOVED',
      ]),
    );
  });

  it('protects the last explicit owner and caller self-lockout', async () => {
    await expect(
      permissions.setUser(actorId, nodeId, actorId, {
        role: DocumentRole.EDITOR,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      permissions.removeUser(actorId, nodeId, actorId),
    ).rejects.toMatchObject({
      status: 409,
    });

    await permissions.setGroup(actorId, nodeId, groupId, {
      role: DocumentRole.OWNER,
    });
    await expect(
      permissions.setUser(actorId, nodeId, actorId, {
        role: DocumentRole.EDITOR,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await permissions.setGroup(actorId, nodeId, actorOwnerGroupId, {
      role: DocumentRole.OWNER,
    });
    await expect(
      permissions.removeUser(actorId, nodeId, actorId),
    ).resolves.toBeUndefined();
  });

  it('updates inheritance without materializing rows and rejects actor lockout', async () => {
    const beforeCount = await prisma.permissionEntry.count({
      where: { nodeId: inheritedNodeId },
    });
    await expect(
      permissions.updateSettings(actorId, inheritedNodeId, {
        inheritPermissions: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await prisma.node.findFirstOrThrow({
        where: { id: inheritedNodeId },
        select: { inheritPermissions: true },
      }),
    ).toEqual({ inheritPermissions: true });
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId: inheritedNodeId },
      }),
    ).toBe(beforeCount);
    await permissions.setGroup(actorId, inheritedNodeId, actorOwnerGroupId, {
      role: DocumentRole.OWNER,
    });
    await expect(
      permissions.updateSettings(actorId, inheritedNodeId, {
        inheritPermissions: false,
      }),
    ).resolves.toEqual({ nodeId: inheritedNodeId, inheritPermissions: false });
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: {
          resourceId: inheritedNodeId,
          action: 'PERMISSION_INHERITANCE_UPDATED',
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('cannot let concurrent owner removals leave zero explicit owners', async () => {
    const concurrent = await prisma.node.create({
      data: {
        type: NodeType.FOLDER,
        name: `concurrent-permissions-${suffix}`,
        normalizedName: `concurrent-permissions-${suffix}`,
        createdById: actorId,
      },
    });
    nodeIds.add(concurrent.id);
    await prisma.permissionEntry.createMany({
      data: [
        { nodeId: concurrent.id, userId: actorId, role: DocumentRole.OWNER },
        { nodeId: concurrent.id, userId: ownerBId, role: DocumentRole.OWNER },
      ],
    });
    const results = await Promise.allSettled([
      permissions.removeUser(actorId, concurrent.id, ownerBId),
      permissions.removeUser(ownerBId, concurrent.id, actorId),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.permissionEntry.count({
        where: { nodeId: concurrent.id, role: DocumentRole.OWNER },
      }),
    ).toBe(1);
  });
});
