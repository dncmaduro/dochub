import { ForbiddenException } from '@nestjs/common';
import { SystemRole, UserStatus } from '@dochub/database';
import { DatabaseService } from '../database/database.service.js';
import {
  ADMIN_DOCUMENT_CAPABILITIES,
  DocumentCapability,
  READ_DOCUMENT_CAPABILITIES,
} from './document-capability.js';
import { DocumentAuthorizationService } from './document-authorization.service.js';

const nodeId = 'a0000000-0000-4000-8000-000000000001';
const parentId = 'a0000000-0000-4000-8000-000000000002';
const userId = 'a0000000-0000-4000-8000-000000000003';

function createService({
  nodeChain,
  role = SystemRole.VIEWER,
  status = UserStatus.ACTIVE,
}: {
  nodeChain: object[];
  role?: SystemRole;
  status?: UserStatus;
}) {
  const queryRaw = vi.fn().mockResolvedValue(nodeChain);
  const userFindUnique = vi.fn().mockResolvedValue({ status, systemRole: role });
  const permissionFindMany = vi.fn();
  const database = {
    prisma: {
      $queryRaw: queryRaw,
      user: { findUnique: userFindUnique },
      permissionEntry: { findMany: permissionFindMany },
    },
  } as unknown as DatabaseService;

  return {
    service: new DocumentAuthorizationService(database),
    queryRaw,
    userFindUnique,
    permissionFindMany,
  };
}

const liveNode = {
  id: nodeId,
  parentId,
  inheritPermissions: false,
  generalAccessRole: 'EDITOR',
  trashOperationId: null,
  depth: 0,
};

describe('DocumentAuthorizationService', () => {
  it('grants every supported capability to an active administrator without ACL entries', async () => {
    const { service, permissionFindMany } = createService({
      nodeChain: [liveNode],
      role: SystemRole.ADMIN,
    });

    await expect(service.resolveCapabilities(userId, nodeId)).resolves.toEqual({
      nodeId,
      capabilities: new Set(ADMIN_DOCUMENT_CAPABILITIES),
    });
    expect(permissionFindMany).not.toHaveBeenCalled();
  });

  it('keeps active non-administrators read-only even with OWNER/EDITOR-style ACL data', async () => {
    const { service, permissionFindMany } = createService({
      nodeChain: [liveNode],
      role: SystemRole.DOCUMENT_MANAGER,
    });

    await expect(service.resolveCapabilities(userId, nodeId)).resolves.toEqual({
      nodeId,
      capabilities: new Set(READ_DOCUMENT_CAPABILITIES),
    });
    await expect(
      service.hasCapability(userId, nodeId, DocumentCapability.DELETE),
    ).resolves.toBe(false);
    expect(permissionFindMany).not.toHaveBeenCalled();
  });

  it('gives viewers the same read-only account policy', async () => {
    const { service } = createService({ nodeChain: [liveNode] });
    await expect(service.resolveCapabilities(userId, nodeId)).resolves.toEqual({
      nodeId,
      capabilities: new Set(READ_DOCUMENT_CAPABILITIES),
    });
  });

  it('fails closed for missing nodes and inactive accounts', async () => {
    for (const scenario of [
      { nodeChain: [], role: SystemRole.ADMIN, status: UserStatus.ACTIVE },
      {
        nodeChain: [{ ...liveNode, trashOperationId: 'a0000000-0000-4000-8000-000000000005' }],
        role: SystemRole.ADMIN,
        status: UserStatus.ACTIVE,
      },
      { nodeChain: [liveNode], role: SystemRole.ADMIN, status: UserStatus.SUSPENDED },
      { nodeChain: [liveNode], role: SystemRole.ADMIN, status: UserStatus.INVITED },
      { nodeChain: [liveNode], role: SystemRole.ADMIN, status: UserStatus.PENDING_APPROVAL },
    ]) {
      const { service } = createService(scenario);
      await expect(
        service.hasCapability(userId, nodeId, DocumentCapability.VIEW),
      ).resolves.toBe(false);
    }
  });

  it('keeps trashed nodes hidden normally while allowing an active administrator to resolve Trash capabilities', async () => {
    const trashedChain = [
      { ...liveNode, trashOperationId: 'a0000000-0000-4000-8000-000000000005' },
    ];
    const normal = createService({ nodeChain: trashedChain, role: SystemRole.ADMIN });
    const lifecycle = createService({ nodeChain: trashedChain, role: SystemRole.ADMIN });

    await expect(
      normal.service.hasCapability(userId, nodeId, DocumentCapability.VIEW),
    ).resolves.toBe(false);
    await expect(
      lifecycle.service.resolveTrashCapabilities(userId, nodeId),
    ).resolves.toEqual({
      nodeId,
      capabilities: new Set(ADMIN_DOCUMENT_CAPABILITIES),
    });
  });

  it('asserts mutations through the same effective capability boundary', async () => {
    const { service } = createService({ nodeChain: [liveNode] });
    await expect(
      service.assertCapability(userId, nodeId, DocumentCapability.DELETE),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
