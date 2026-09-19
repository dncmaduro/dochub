import { ForbiddenException } from '@nestjs/common';
import { DocumentRole } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import { DocumentCapability } from './document-capability.js';
import { DocumentAuthorizationService } from './document-authorization.service.js';

const nodeId = 'a0000000-0000-4000-8000-000000000001';
const parentId = 'a0000000-0000-4000-8000-000000000002';
const userId = 'a0000000-0000-4000-8000-000000000003';
const groupId = 'a0000000-0000-4000-8000-000000000004';

function createService({
  nodeChain,
  memberships = [{ userId, groupId }],
  roles = [DocumentRole.VIEWER],
}: {
  nodeChain: object[];
  memberships?: object[];
  roles?: DocumentRole[];
}) {
  const queryRaw = vi
    .fn()
    .mockResolvedValueOnce(nodeChain)
    .mockResolvedValueOnce(memberships);
  const findMany = vi.fn().mockResolvedValue(roles.map((role) => ({ role })));
  const database = {
    prisma: { $queryRaw: queryRaw, permissionEntry: { findMany } },
  } as unknown as DatabaseService;

  return {
    service: new DocumentAuthorizationService(database),
    queryRaw,
    findMany,
  };
}

describe('DocumentAuthorizationService', () => {
  it('unions explicit user and group permissions across an inheritable chain', async () => {
    const { service, queryRaw, findMany } = createService({
      nodeChain: [
        {
          id: nodeId,
          parentId,
          inheritPermissions: true,
          trashOperationId: null,
          depth: 0,
        },
        {
          id: parentId,
          parentId: null,
          inheritPermissions: true,
          trashOperationId: null,
          depth: 1,
        },
      ],
      roles: [DocumentRole.VIEWER, DocumentRole.EDITOR],
    });

    const resolved = await service.resolveCapabilities(userId, nodeId);

    expect(resolved.capabilities).toEqual(
      new Set([
        DocumentCapability.VIEW,
        DocumentCapability.PREVIEW,
        DocumentCapability.DOWNLOAD,
        DocumentCapability.CREATE,
        DocumentCapability.EDIT,
        DocumentCapability.RENAME,
        DocumentCapability.MOVE,
        DocumentCapability.DELETE,
        DocumentCapability.RESTORE_VERSION,
      ]),
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        nodeId: { in: [nodeId, parentId] },
        OR: [{ userId }, { groupId: { in: [groupId] } }],
      },
      select: { role: true },
    });
  });

  it('fails closed for a missing node, a trashed ancestor, or a missing user', async () => {
    for (const scenario of [
      { nodeChain: [], memberships: [] },
      {
        nodeChain: [
          {
            id: nodeId,
            parentId: null,
            inheritPermissions: true,
            trashOperationId: 'a0000000-0000-4000-8000-000000000005',
            depth: 0,
          },
        ],
        memberships: [],
      },
      {
        nodeChain: [
          {
            id: nodeId,
            parentId: null,
            inheritPermissions: true,
            trashOperationId: null,
            depth: 0,
          },
        ],
        memberships: [],
      },
    ]) {
      const { service, findMany } = createService(scenario);
      await expect(
        service.hasCapability(userId, nodeId, DocumentCapability.VIEW),
      ).resolves.toBe(false);
      expect(findMany).not.toHaveBeenCalled();
    }
  });

  it('does not grant a capability that no explicit permission grants', async () => {
    const { service } = createService({
      nodeChain: [
        {
          id: nodeId,
          parentId: null,
          inheritPermissions: false,
          trashOperationId: null,
          depth: 0,
        },
      ],
      roles: [DocumentRole.VIEWER],
    });

    await expect(
      service.assertCapability(userId, nodeId, DocumentCapability.DELETE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not derive access from an administrator or node creator', async () => {
    const { service } = createService({
      nodeChain: [
        {
          id: nodeId,
          parentId: null,
          inheritPermissions: false,
          trashOperationId: null,
          depth: 0,
          createdById: userId,
        },
      ],
      memberships: [{ userId, groupId: null, systemRole: 'ADMIN' }],
      roles: [],
    });

    await expect(
      service.hasCapability(userId, nodeId, DocumentCapability.VIEW),
    ).resolves.toBe(false);
  });
});
