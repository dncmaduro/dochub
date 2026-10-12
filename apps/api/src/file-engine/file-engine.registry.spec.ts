import { describe, expect, it, vi } from 'vitest';
import { FileEngineRegistry } from './file-engine.registry.js';
import type { FileDescriptor } from './file-engine.types.js';

const registry = new FileEngineRegistry();

function file(name: string, mimeType: string | null = null): FileDescriptor {
  return {
    fileId: 'file-id',
    nodeId: 'node-id',
    name,
    mimeType,
    extension: null,
    size: 10,
    storageRef: { provider: 'GOOGLE_DRIVE', objectId: 'object-id' },
  };
}

describe('FileEngineRegistry', () => {
  it.each([
    ['report.doc', 'application/msword', 'DOCUMENT'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCUMENT'],
    ['budget.xls', 'application/vnd.ms-excel', 'SPREADSHEET'],
    ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'SPREADSHEET'],
    ['budget.csv', 'text/csv', 'SPREADSHEET'],
    ['slides.ppt', 'application/vnd.ms-powerpoint', 'PRESENTATION'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PRESENTATION'],
    ['brief.pdf', 'application/pdf', 'PDF'],
    ['photo.jpg', 'image/jpeg', 'IMAGE'],
    ['photo.jpeg', 'image/jpeg', 'IMAGE'],
    ['photo.png', 'image/png', 'IMAGE'],
    ['photo.webp', 'image/webp', 'IMAGE'],
    ['photo.gif', 'image/gif', 'IMAGE'],
    ['notes.txt', 'text/plain', 'TEXT'],
    ['notes.md', 'text/markdown', 'TEXT'],
    ['data.json', 'application/json', 'TEXT'],
    ['data.xml', 'application/xml', 'TEXT'],
    ['movie.mp4', 'video/mp4', 'VIDEO'],
    ['movie.webm', 'video/webm', 'VIDEO'],
    ['song.mp3', 'audio/mpeg', 'AUDIO'],
    ['unknown.bin', 'application/octet-stream', 'FALLBACK'],
  ])('resolves %s as %s', (name, mimeType, expected) => {
    expect(registry.resolve(file(name, mimeType)).engine.id).toBe(expected);
  });

  it('uses a controlled extension when the MIME is generic', () => {
    expect(registry.resolve(file('report.docx', 'application/octet-stream')).engine.id).toBe('DOCUMENT');
    expect(registry.resolve(file('report.docx', null)).engine.id).toBe('DOCUMENT');
  });

  it('routes CSV through the native spreadsheet preview path', async () => {
    await expect(registry.openPreview(file('budget.csv', 'text/csv'))).resolves.toMatchObject({
      kind: 'spreadsheet',
      engine: { id: 'SPREADSHEET' },
    });
  });

  it('gives a trusted MIME type precedence over a conflicting extension', () => {
    expect(registry.resolve(file('report.docx', 'application/pdf')).engine.id).toBe('PDF');
    expect(registry.resolve(file('report.docx', 'application/vnd.google-apps.document')).engine.id).toBe('LEGACY_GOOGLE_NATIVE');
    expect(registry.resolve(file('budget.xlsx', 'application/vnd.google-apps.spreadsheet')).engine.id).toBe('LEGACY_GOOGLE_NATIVE');
    expect(registry.resolve(file('slides.pptx', 'application/vnd.google-apps.presentation')).engine.id).toBe('LEGACY_GOOGLE_NATIVE');
  });

  it('does not let an unsupported trusted MIME be reclassified by its extension', () => {
    expect(registry.resolve(file('report.docx', 'application/x-company-format')).engine.id).toBe('FALLBACK');
  });

  it('returns capability metadata separately from authorization', () => {
    const resolved = registry.resolve(file('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    expect(resolved.capabilities).toEqual({
      preview: true,
      edit: true,
      download: true,
      textExtraction: false,
      thumbnail: false,
    });
  });

  it('uses StorageProvider for physical preview content', async () => {
    const storage = {
      openRead: vi.fn().mockResolvedValue({
        stream: {},
        metadata: { mimeType: 'application/pdf', sizeBytes: 4n },
        range: null,
      }),
    };
    const engine = registry.get('PDF');
    await engine.openContent?.(file('brief.pdf', 'application/pdf'), { storage: storage as never });
    expect(storage.openRead).toHaveBeenCalledWith(
      { provider: 'GOOGLE_DRIVE', objectId: 'object-id' },
      undefined,
    );
  });

  it('keeps office conversion behind the document engine', async () => {
    const converted = { stream: {}, mimeType: 'application/pdf', sizeBytes: 5n, range: null };
    const engine = registry.get('DOCUMENT');
    await expect(engine.openContent?.(file('report.doc', 'application/msword'), {
      storage: {} as never,
      openLibreOfficePreview: vi.fn().mockResolvedValue(converted),
    })).resolves.toBe(converted);
  });

  it('keeps native DOCX content on the provider-backed download path', async () => {
    const storage = { openRead: vi.fn().mockResolvedValue({ stream: {}, metadata: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: 5n }, range: null }) };
    const engine = registry.get('DOCUMENT');
    await expect(engine.openContent?.(file('report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), { storage: storage as never, openLibreOfficePreview: vi.fn() })).resolves.toMatchObject({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(storage.openRead).toHaveBeenCalledOnce();
  });

  it('produces an unavailable preview for fallback formats', async () => {
    await expect(registry.openPreview(file('archive.bin', 'application/octet-stream'))).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'unsupported',
      engine: { id: 'FALLBACK' },
    });
  });
});
