import { describe, expect, it, vi } from 'vitest';
import { DocumentCapability } from '../authorization/document-capability.js';
import { DrivePreviewService } from './drive-preview.service.js';

function serviceFor({
  capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD]),
  node = {
    id: 'node',
    name: 'Quarterly report',
    type: 'FILE',
    file: {
      backingType: 'GOOGLE_DRIVE',
      driveFile: {
        driveFileId: 'drive-file',
        mimeType: 'application/vnd.google-apps.document',
        sizeBytes: 24n,
        sourceStatus: 'CONNECTED',
        trashed: false,
      },
    },
  },
} = {}) {
  const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities }) };
  const database = { prisma: { node: { findFirst: vi.fn().mockResolvedValue(node) }, user: { findUnique: vi.fn() } } };
  const jwt = { signAsync: vi.fn().mockResolvedValue('signed-drive-preview'), verifyAsync: vi.fn() };
  const drive = { assertReadableDrive: vi.fn().mockResolvedValue(undefined), openPreviewContent: vi.fn() };
  return {
    service: new DrivePreviewService(database as never, authorization as never, jwt as never, drive as never),
    authorization,
    database,
    jwt,
    drive,
  };
}

describe('DrivePreviewService', () => {
  it('creates a server-held PDF export session for native Google files', async () => {
    const { service, drive, jwt, database } = serviceFor();
    const preview = await service.create('user', 'node');
    expect(preview).toMatchObject({
      previewable: true,
      nodeId: 'node',
      contentUrl: expect.stringMatching(/^\/drive-preview\//),
      mimeType: 'application/pdf',
      filename: 'Quarterly report',
    });
    expect(preview).toHaveProperty('token', 'signed-drive-preview');
    expect(drive.assertReadableDrive).toHaveBeenCalledOnce();
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        typ: 'drive-preview',
        nid: 'node',
        did: 'drive-file',
        exportMimeType: 'application/pdf',
      }),
      expect.objectContaining({ audience: 'dochub-drive-preview' }),
    );
    expect(database.prisma).not.toHaveProperty('fileVersion');
  });

  it('keeps unsupported Drive binaries unavailable while allowing authorized download', async () => {
    const { service, drive } = serviceFor({
      node: {
        id: 'node',
        name: 'Legacy.docx',
        type: 'FILE',
        file: {
          backingType: 'GOOGLE_DRIVE',
          driveFile: {
            driveFileId: 'drive-file',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 24n,
            sourceStatus: 'CONNECTED',
            trashed: false,
          },
        },
      },
    });
    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: false, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(drive.assertReadableDrive).toHaveBeenCalledOnce();
  });

  it('requires both VIEW and PREVIEW before creating a Drive session', async () => {
    const { service, database } = serviceFor({ capabilities: new Set([DocumentCapability.VIEW]) });
    await expect(service.create('user', 'node')).rejects.toMatchObject({ status: 403 });
    expect(database.prisma.node.findFirst).not.toHaveBeenCalled();
  });

  it('delegates content access without exposing a provider token', async () => {
    const { service, drive } = serviceFor();
    const content = { stream: {} };
    drive.openPreviewContent.mockResolvedValue(content);
    const preview = {
      typ: 'drive-preview' as const,
      sid: 'session',
      sub: 'user',
      nid: 'node',
      did: 'drive-file',
      mimeType: 'application/pdf',
      exportMimeType: 'application/pdf',
      filename: 'Quarterly report',
    };
    await expect(service.openContent(preview, 'bytes=0-4')).resolves.toBe(content);
    expect(drive.openPreviewContent).toHaveBeenCalledWith('drive-file', 'application/pdf', 'bytes=0-4');
  });
});
