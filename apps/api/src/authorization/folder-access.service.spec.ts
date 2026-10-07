import { SystemRole, UserStatus } from '@dochub/database';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from './document-capability.js';
import { FolderAccessService } from './folder-access.service.js';

function harness(role: SystemRole, status = UserStatus.ACTIVE) {
  const userFindUnique = vi.fn().mockResolvedValue({ status, systemRole: role });
  const authorization = {
    hasDocumentManager: vi.fn().mockResolvedValue(
      role === SystemRole.ADMIN || role === SystemRole.DOCUMENT_MANAGER,
    ),
    resolveCapabilities: vi.fn(),
  };
  const service = new FolderAccessService(
    { prisma: { user: { findUnique: userFindUnique } } } as any,
    authorization as any,
  );
  return { service, userFindUnique, authorization };
}

describe('FolderAccessService account role boundary', () => {
  it.each([SystemRole.ADMIN, SystemRole.DOCUMENT_MANAGER])(
    'grants %s root placement access',
    async (role) => {
      const { service } = harness(role);
      const folder = await service.requireCreate('user-id', null);
      expect(folder.capabilities).toEqual(
        new Set([DocumentCapability.VIEW, DocumentCapability.CREATE]),
      );
    },
  );

  it('lets an active viewer browse the virtual root but not create', async () => {
    const { service } = harness(SystemRole.VIEWER);
    const folder = await service.requireBrowse('user-id', null);
    expect(folder.capabilities).toEqual(new Set([DocumentCapability.VIEW]));
    await expect(service.requireCreate('user-id', null)).rejects.toThrow(
      'Document-management access is required for root placement',
    );
  });

  it('fails closed for inactive accounts', async () => {
    const { service } = harness(SystemRole.ADMIN, UserStatus.SUSPENDED);
    await expect(service.requireBrowse('user-id', null)).rejects.toThrow(
      'Node not found',
    );
  });
});
