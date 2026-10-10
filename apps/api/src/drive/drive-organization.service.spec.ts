import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DriveOrganizationService } from './drive-organization.service.js';

function harness() {
  const actorUserId = randomUUID();
  const driveFile = { id: randomUUID(), driveFileId: 'drive-file-1', name: 'Plan' };
  const node = { id: randomUUID(), parentId: null, name: 'Plan' };
  const file = { id: randomUUID() };
  const auditLog: any[] = [];
  const tx = {
    file: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => file),
      delete: vi.fn(async () => file),
    },
    node: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => node),
      delete: vi.fn(async () => node),
    },
    auditLog: {
      create: vi.fn(async (args: any) => auditLog.push(args.data)),
    },
    user: { findUnique: vi.fn(async () => ({ status: 'ACTIVE', systemRole: 'DOCUMENT_MANAGER' })) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const authorization = {
    assertDocumentManager: vi.fn(async () => undefined),
  };
  const folders = {
    resolve: vi.fn(async () => ({
      node: null,
      capabilities: new Set([DocumentCapability.VIEW]),
    })),
  };
  const drive = {
    prepareDriveFileForImport: vi.fn(async () => ({
      integrationId: 'integration-1',
      driveFile,
      remoteFile: {
        id: driveFile.driveFileId,
        name: driveFile.name,
        mimeType: 'application/pdf',
        parents: ['storage-folder'],
      },
    })),
  };
  return {
    actorUserId,
    driveFile,
    node,
    file,
    auditLog,
    tx,
    authorization,
    folders,
    drive,
    service: new DriveOrganizationService(
      { prisma } as any,
      authorization as any,
      folders as any,
      drive as any,
    ),
  };
}

describe('DriveOrganizationService', () => {
  it('creates a metadata-only root reference and audits the logical import', async () => {
    const h = harness();
    await expect(
      h.service.addToDocsHub(h.actorUserId, h.driveFile.driveFileId, {}),
    ).resolves.toMatchObject({ nodeId: h.node.id, parentId: null });
    expect(h.tx.file.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        backingType: 'GOOGLE_DRIVE',
        driveFileId: h.driveFile.id,
      }),
    }));
    expect(h.drive.prepareDriveFileForImport).toHaveBeenCalledWith(
      h.actorUserId,
      h.driveFile.driveFileId,
    );
    expect(h.auditLog[0]).toMatchObject({ action: 'DRIVE_FILE_ADDED_TO_DOCSHUB' });
  });

  it('removes only the logical reference and leaves the Drive metadata untouched', async () => {
    const h = harness();
    h.tx.node.findFirst.mockResolvedValue({
      id: h.node.id,
      type: 'FILE',
      file: {
        id: h.file.id,
        backingType: 'GOOGLE_DRIVE',
        driveFile: { driveFileId: h.driveFile.driveFileId },
      },
    });
    await expect(
      h.service.removeFromDocsHub(h.actorUserId, h.node.id),
    ).resolves.toEqual({ nodeId: h.node.id, removed: true });
    expect(h.tx.file.delete).toHaveBeenCalledWith({ where: { id: h.file.id } });
    expect(h.tx.node.delete).toHaveBeenCalledWith({ where: { id: h.node.id } });
    expect(h.tx).not.toHaveProperty('driveFile.delete');
    expect(h.auditLog[0]).toMatchObject({ action: 'DRIVE_FILE_REMOVED_FROM_DOCSHUB' });
  });

  it('does not organize a reference when the manager gate denies the actor', async () => {
    const h = harness();
    h.authorization.assertDocumentManager.mockRejectedValue(
      new Error('manager denied'),
    );
    await expect(
      h.service.addToDocsHub(h.actorUserId, h.driveFile.driveFileId, {}),
    ).rejects.toThrow('manager denied');
    expect(h.tx.node.create).not.toHaveBeenCalled();
    expect(h.tx.file.create).not.toHaveBeenCalled();
  });
});
