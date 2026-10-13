import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { Readable } from 'node:stream';
import { DocumentCapability } from '../authorization/document-capability.js';
import { affiliateOrdersFixture } from '../file-engine/spreadsheet/affiliate-orders.fixture.js';
import { DrivePreviewService } from './drive-preview.service.js';

const nativeXlsx = Buffer.from(zipSync({
  'xl/workbook.xml': new TextEncoder().encode('<workbook xmlns:r="urn:r"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': new TextEncoder().encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': new TextEncoder().encode('<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'),
}));
const nativePptx = Buffer.from(zipSync({
  'ppt/presentation.xml': new TextEncoder().encode('<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldSz cx="9144000" cy="5143500"/><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>'),
  'ppt/_rels/presentation.xml.rels': new TextEncoder().encode('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml" Type="/slide"/></Relationships>'),
  'ppt/slides/slide1.xml': new TextEncoder().encode('<p:sld xmlns:p="urn:p"><p:cSld><p:spTree/></p:cSld></p:sld>'),
}));

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
  it('re-authorizes viewer saves on the server', async () => {
    const { service } = serviceFor();
    await expect(service.saveDocument('user', 'node', {})).rejects.toThrow('required document capability');
  });

  it('allows an authorized editor to reach the native engine save path', async () => {
    const capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD, DocumentCapability.EDIT]);
    const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities }) };
    const database = { prisma: { node: { findFirst: vi.fn().mockResolvedValue({
      id: 'node', name: 'report.docx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    }) } } };
    const saved = { storageRevision: '8', model: { version: 1, blocks: [] } };
    const engine = { id: 'DOCUMENT', save: vi.fn().mockResolvedValue(saved) };
    const registry = { resolve: vi.fn().mockReturnValue({ engine, capabilities: { preview: true, edit: true, download: true, textExtraction: false, thumbnail: false } }) };
    const storage = {};
    const service = new DrivePreviewService(database as never, authorization as never, {} as never, {} as never, storage as never, registry as never);
    await expect(service.saveDocument('editor', 'node', { expectedRevision: '7', blocks: [] })).resolves.toBe(saved);
    expect(engine.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'report.docx' }), expect.objectContaining({ expectedRevision: '7' }), { storage, expectedRevision: '7' });
  });

  it('plans native XLSX preview with edit capability and a workbook model URL', async () => {
    const capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD, DocumentCapability.EDIT]);
    const { service, storage } = serviceFor({ capabilities, node: {
      id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    storage.stat.mockResolvedValue({ sizeBytes: 10n, revision: 'r1' });
    storage.openRead.mockResolvedValue({ stream: Readable.from([nativeXlsx]), metadata: { sizeBytes: BigInt(nativeXlsx.byteLength), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, range: null });
    await expect(service.create('editor', 'node')).resolves.toMatchObject({ previewable: true, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modelUrl: expect.stringContaining('/content/model'), capabilities: { edit: true }, storageRevision: 'r1' });
  });

  it('uses the filename extension when Drive upload metadata is generic', async () => {
    const capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD, DocumentCapability.EDIT]);
    const { service, storage } = serviceFor({ capabilities, node: {
      id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/octet-stream', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    storage.stat.mockResolvedValue({ sizeBytes: 10n, revision: 'r1' });
    storage.openRead.mockResolvedValue({ stream: Readable.from([nativeXlsx]), metadata: { sizeBytes: BigInt(nativeXlsx.byteLength), mimeType: 'application/octet-stream' }, range: null });
    await expect(service.create('editor', 'node')).resolves.toMatchObject({
      previewable: true,
      engine: 'SPREADSHEET',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      preview: { kind: 'spreadsheet' },
      modelUrl: expect.stringContaining('/content/model'),
      capabilities: { edit: true },
      storageRevision: 'r1',
    });
  });

  it('returns a native spreadsheet preview session for a realistic uploaded XLSX', async () => {
    const capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD, DocumentCapability.EDIT]);
    const { service, storage } = serviceFor({ capabilities, node: {
      id: 'node', name: 'affiliate_orders_7695543313789257492.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/octet-stream', sizeBytes: BigInt(affiliateOrdersFixture().byteLength), sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    const source = affiliateOrdersFixture();
    storage.stat.mockResolvedValue({ sizeBytes: BigInt(source.byteLength), revision: 'affiliate-r1' });
    storage.openRead.mockResolvedValue({ stream: Readable.from([source]), metadata: { sizeBytes: BigInt(source.byteLength), mimeType: 'application/octet-stream' }, range: null });

    await expect(service.create('editor', 'node')).resolves.toMatchObject({
      previewable: true,
      engine: 'SPREADSHEET',
      preview: { kind: 'spreadsheet' },
      modelUrl: expect.stringContaining('/content/model'),
      storageRevision: 'affiliate-r1',
      capabilities: { edit: true },
    });
  });

  it('logs a safe parser failure category before marking a broken workbook unavailable', async () => {
    const brokenRelationships = Buffer.from(zipSync({
      'xl/workbook.xml': new TextEncoder().encode('<workbook xmlns:r="urn:r"><sheets><sheet name="Orders" r:id="missing"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': new TextEncoder().encode('<Relationships/>'),
    }));
    const { service, storage } = serviceFor({ node: {
      id: 'node', name: 'affiliate_orders_7695543313789257492.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: BigInt(brokenRelationships.byteLength), sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    storage.openRead.mockResolvedValue({ stream: Readable.from([brokenRelationships]), metadata: { sizeBytes: BigInt(brokenRelationships.byteLength), mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, range: null });
    const logger = (service as unknown as { logger: { warn: (message: string) => void } }).logger;
    const logWarning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: false, preview: { kind: 'unavailable' } });
    expect(logWarning).toHaveBeenCalledWith('Native spreadsheet preview unavailable (relationships)');
  });

  it('does not let a misleading PDF MIME become native XLSX', async () => {
    const { service } = serviceFor({ node: {
      id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/pdf', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    await expect(service.create('user', 'node')).resolves.toMatchObject({
      previewable: true,
      engine: 'PDF',
      mimeType: 'application/pdf',
      preview: { kind: 'pdf' },
    });
  });

  it('logs unexpected native parser failures before returning a safe preview error', async () => {
    const { authorization, database, jwt, drive, storage } = serviceFor({ node: {
      id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    const engine = {
      id: 'SPREADSHEET',
      openPreview: vi.fn().mockResolvedValue({ kind: 'spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      openModel: vi.fn().mockRejectedValue(new Error('unexpected parser bug')),
    };
    const registry = { resolve: vi.fn().mockReturnValue({ engine, capabilities: { preview: true, edit: true, download: true, textExtraction: false, thumbnail: false } }) };
    const service = new DrivePreviewService(database as never, authorization as never, jwt as never, drive as never, storage as never, registry as never);
    const logger = (service as unknown as { logger: { error: (message: string) => void } }).logger;
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(service.create('user', 'node')).rejects.toMatchObject({ status: 503 });
    expect(logError).toHaveBeenCalledWith('Native spreadsheet preview failed unexpectedly (preview-session)');
  });

  it('logs registry resolution failures before returning a safe preview error', async () => {
    const { authorization, database, jwt, drive, storage } = serviceFor({ node: {
      id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: {
        driveFileId: 'drive-file', mimeType: 'application/octet-stream', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false,
      } },
    } });
    const registry = { resolve: vi.fn().mockImplementation(() => { throw new Error('registry bug'); }) };
    const service = new DrivePreviewService(database as never, authorization as never, jwt as never, drive as never, storage as never, registry as never);
    const logger = (service as unknown as { logger: { error: (message: string) => void } }).logger;
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(service.create('user', 'node')).rejects.toMatchObject({ status: 503 });
    expect(logError).toHaveBeenCalledWith('Preview engine registry failure (registry)');
  });

  it('re-authorizes and delegates native spreadsheet saves', async () => {
    const capabilities = new Set([DocumentCapability.VIEW, DocumentCapability.PREVIEW, DocumentCapability.DOWNLOAD, DocumentCapability.EDIT]);
    const authorization = { resolveCapabilities: vi.fn().mockResolvedValue({ capabilities }) };
    const database = { prisma: { node: { findFirst: vi.fn().mockResolvedValue({ id: 'node', name: 'report.xlsx', type: 'FILE', file: { backingType: 'GOOGLE_DRIVE', id: 'file', driveFile: { driveFileId: 'drive-file', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sizeBytes: 10n, sourceStatus: 'CONNECTED', trashed: false } } }) } } };
    const saved = { storageRevision: 'r2', model: { version: 1, sheets: [], activeSheetId: 'sheet' } };
    const engine = { id: 'SPREADSHEET', save: vi.fn().mockResolvedValue(saved) };
    const registry = { resolve: vi.fn().mockReturnValue({ engine, capabilities: { preview: true, edit: true, download: true, textExtraction: false, thumbnail: false } }) };
    const service = new DrivePreviewService(database as never, authorization as never, {} as never, {} as never, {} as never, registry as never);
    await expect(service.saveSpreadsheet('editor', 'node', { expectedRevision: 'r1', edits: [{ sheetId: 'sheet', cell: 'A1', value: 'ok' }] })).resolves.toBe(saved);
    expect(engine.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'report.xlsx' }), expect.objectContaining({ expectedRevision: 'r1' }), expect.objectContaining({ expectedRevision: 'r1' }));
  });

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
    const { service, drive, storage } = serviceFor({
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
    if (sourceMimeType === 'text/plain') {
      storage.openRead.mockResolvedValue({
        stream: Readable.from([Buffer.from('preview text', 'utf8')]),
        metadata: { sizeBytes: 12n, mimeType: sourceMimeType },
        range: null,
      });
    }
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
    ['application/msword', 'report.doc', 'application/pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'report.docx', 'application/pdf'],
    ['application/vnd.ms-excel', 'report.xls', 'application/pdf'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['application/vnd.ms-powerpoint', 'report.ppt', 'application/pdf'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'report.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('plans %s for the native or LibreOffice preview path', async (mimeType, filename, expectedMimeType) => {
    const { service, drive, storage } = serviceFor({
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
    if (filename === 'report.xlsx') storage.openRead.mockResolvedValue({ stream: Readable.from([nativeXlsx]), metadata: { sizeBytes: BigInt(nativeXlsx.byteLength), mimeType }, range: null });
    if (filename === 'report.pptx') storage.openRead.mockResolvedValue({ stream: Readable.from([nativePptx]), metadata: { sizeBytes: BigInt(nativePptx.byteLength), mimeType }, range: null });
    await expect(service.create('user', 'node')).resolves.toMatchObject({ previewable: true, mimeType: expectedMimeType });
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
