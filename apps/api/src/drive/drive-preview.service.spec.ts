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
  const drive = { assertReadableDrive: vi.fn().mockResolvedValue(undefined), openPreviewContent: vi.fn(), openPreviewExport: vi.fn() };
  const storage = { stat: vi.fn().mockResolvedValue({ sizeBytes: 24n }), openRead: vi.fn() };
  return {
    service: new DrivePreviewService(database as never, authorization as never, jwt as never, drive as never, storage as never),
    authorization,
    database,
    jwt,
    drive,
    storage,
  };
}

describe('DrivePreviewService', () => {
  it('exports Google-native files as PDF previews', async () => {
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
      }),
      expect.objectContaining({ audience: 'dochub-drive-preview' }),
    );
    expect(database.prisma).not.toHaveProperty('fileVersion');
  });

  it.each([
    ['application/pdf', 'application/pdf'],
    ['image/png', 'image/png'],
    ['video/mp4', 'video/mp4'],
    ['video/webm', 'video/webm'],
    ['text/plain', 'text/plain'],
  ])('streams %s directly from Drive', async (sourceMimeType, previewMimeType) => {
    const { service, drive } = serviceFor({
      node: {
        id: 'node',
        name: 'asset',
        type: 'FILE',
        file: {
          backingType: 'GOOGLE_DRIVE',
          driveFile: {
            driveFileId: 'drive-file',
            mimeType: sourceMimeType,
            sizeBytes: 24n,
            sourceStatus: 'CONNECTED',
            trashed: false,
          },
        },
      },
    });

    await expect(service.create('user', 'node')).resolves.toMatchObject({
      previewable: true,
      mimeType: previewMimeType,
    });
    expect(drive.assertReadableDrive).toHaveBeenCalledOnce();
  });

  it('does not classify an unsupported video MIME as browser-previewable', async () => {
    const { service } = serviceFor({
      node: {
        id: 'node',
        name: 'asset.mov',
        type: 'FILE',
        file: {
          backingType: 'GOOGLE_DRIVE',
          driveFile: {
            driveFileId: 'drive-file',
            mimeType: 'video/quicktime',
            sizeBytes: 24n,
            sourceStatus: 'CONNECTED',
            trashed: false,
          },
        },
      },
    });

    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: false });
  });

  it.each([
    ['application/msword', 'report.doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx'],
    ['application/vnd.ms-excel', 'report.xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'report.xlsx'],
    ['application/vnd.ms-powerpoint', 'report.ppt'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'report.pptx'],
  ])('plans %s for LibreOffice PDF preview', async (mimeType, filename) => {
    const { service, drive } = serviceFor({
      node: {
        id: 'node',
        name: filename,
        type: 'FILE',
        file: {
          backingType: 'GOOGLE_DRIVE',
          driveFile: {
            driveFileId: 'drive-file',
            mimeType,
            sizeBytes: 24n,
            sourceStatus: 'CONNECTED',
            trashed: false,
          },
        },
      },
    });
    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: true, mimeType: 'application/pdf' });
    expect(drive.assertReadableDrive).toHaveBeenCalledOnce();
  });

  it('uses Google export before extension fallback', async () => {
    const { service, jwt } = serviceFor({
      node: {
        id: 'node',
        name: 'Google report.docx',
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
    });
    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: true, mimeType: 'application/pdf' });
    expect(jwt.signAsync).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google-export' }), expect.anything());
  });

  it('keeps unsupported Drive binaries unavailable while allowing authorized download', async () => {
    const { service, drive } = serviceFor({
      node: {
        id: 'node',
        name: 'archive.bin',
        type: 'FILE',
        file: {
          backingType: 'GOOGLE_DRIVE',
          driveFile: {
            driveFileId: 'drive-file',
            mimeType: 'application/octet-stream',
            sizeBytes: 24n,
            sourceStatus: 'CONNECTED',
            trashed: false,
          },
        },
      },
    });
    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: false, mimeType: 'application/octet-stream' });
    expect(drive.assertReadableDrive).toHaveBeenCalledOnce();
  });

  it('requires both VIEW and PREVIEW before creating a Drive session', async () => {
    const { service, database } = serviceFor({ capabilities: new Set([DocumentCapability.VIEW]) });
    await expect(service.create('user', 'node')).rejects.toMatchObject({ status: 403 });
    expect(database.prisma.node.findFirst).not.toHaveBeenCalled();
  });

  it('delegates content access without exposing a provider token', async () => {
    const { service, storage } = serviceFor();
    const content = { stream: {}, metadata: { mimeType: 'application/pdf', sizeBytes: 5n }, range: null };
    storage.openRead.mockResolvedValue(content);
    const preview = {
      typ: 'drive-preview' as const,
      sid: 'session',
      sub: 'user',
      nid: 'node',
      did: 'drive-file',
      mimeType: 'application/pdf',
      filename: 'Quarterly report',
    };
    await expect(service.openContent(preview, 'bytes=0-4')).resolves.toMatchObject({ stream: content.stream, mimeType: 'application/pdf' });
    expect(storage.openRead).toHaveBeenCalledWith(
      { provider: 'GOOGLE_DRIVE', objectId: 'drive-file' },
      { range: { start: 0, end: 4 } },
    );
  });

  it('uses Drive export for a Google-native preview session', async () => {
    const { service, drive } = serviceFor();
    const content = { stream: {} };
    drive.openPreviewExport.mockResolvedValue(content);
    const preview = {
      typ: 'drive-preview' as const,
      sid: 'session',
      sub: 'user',
      nid: 'node',
      did: 'drive-file',
      kind: 'google-export' as const,
      mimeType: 'application/pdf',
      filename: 'Quarterly report',
    };
    await expect(service.openContent(preview)).resolves.toBe(content);
    expect(drive.openPreviewExport).toHaveBeenCalledWith('drive-file', 'application/pdf');
  });
});
