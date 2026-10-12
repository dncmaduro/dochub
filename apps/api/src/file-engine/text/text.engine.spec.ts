import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { TextEngine } from '../engines/text.engine.js';
import { TextSourceError } from './text-source.js';

function storageFor(value: Buffer, revision = 'r1', mimeType = 'text/plain') {
  let bytes = value;
  let currentRevision = revision;
  return {
    openRead: vi.fn().mockImplementation(async () => ({
      stream: Readable.from([bytes]),
      metadata: { provider: 'GOOGLE_DRIVE', objectId: 'text', mimeType, sizeBytes: BigInt(bytes.byteLength), revision: currentRevision },
      range: null,
    })),
    stat: vi.fn().mockImplementation(async () => ({ provider: 'GOOGLE_DRIVE', objectId: 'text', mimeType, sizeBytes: BigInt(bytes.byteLength), revision: currentRevision })),
    replace: vi.fn().mockImplementation(async (_ref: unknown, input: { stream: AsyncIterable<Buffer> }, _precondition: unknown) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.stream) chunks.push(Buffer.from(chunk));
      bytes = Buffer.concat(chunks);
      currentRevision = 'r2';
      return { metadata: { provider: 'GOOGLE_DRIVE', objectId: 'text', mimeType, sizeBytes: BigInt(bytes.byteLength), revision: currentRevision } };
    }),
    current: () => bytes,
  };
}

function file(name: string, mimeType: string, size: number | null = 100) {
  return {
    fileId: 'file',
    nodeId: 'node',
    name,
    mimeType,
    extension: null,
    size,
    storageRef: { provider: 'GOOGLE_DRIVE' as const, objectId: 'text' },
  };
}

describe('TextEngine', () => {
  it('decodes UTF-8 BOM and preserves CRLF in the native model', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Xin chào\r\nDòng hai\r\n', 'utf8')]);
    const storage = storageFor(bytes);
    const model = await new TextEngine().openModel(file('notes.txt', 'text/plain'), { storage: storage as never, storageRevision: 'r1' });
    expect(model).toMatchObject({ format: 'text', content: 'Xin chào\r\nDòng hai\r\n', bom: true, lineEnding: 'crlf', encoding: 'utf-8', editable: true });
  });

  it('rejects invalid UTF-8 instead of presenting mojibake', async () => {
    const storage = storageFor(Buffer.from([0xc3, 0x28]));
    await expect(new TextEngine().openModel(file('notes.txt', 'text/plain'), { storage: storage as never })).rejects.toBeInstanceOf(TextSourceError);
  });

  it.each([
    ['notes.txt', 'text/plain', 'text'],
    ['notes.md', 'text/markdown', 'markdown'],
    ['data.json', 'application/json', 'json'],
    ['data.xml', 'application/xml', 'xml'],
  ] as const)('provides a native model for %s', async (name, mimeType, format) => {
    const storage = storageFor(Buffer.from(format === 'json' ? '{"name":"Việt Nam"}' : format === 'xml' ? '<root><name>Việt Nam</name></root>' : '# Title', 'utf8'), 'r1', mimeType);
    const model = await new TextEngine().openModel(file(name, mimeType), { storage: storage as never, storageRevision: 'r1' });
    expect(model.format).toBe(format);
  });

  it('keeps malformed JSON accessible while reporting a parse error', async () => {
    const storage = storageFor(Buffer.from('{"name":', 'utf8'), 'r1', 'application/json');
    const model = await new TextEngine().openModel(file('data.json', 'application/json'), { storage: storage as never, storageRevision: 'r1' });
    expect(model).toMatchObject({ format: 'json', parseError: 'JSON is not valid.', content: '{"name":', editable: true });
  });

  it('keeps XML with a DTD inert and source-editable without resolving entities', async () => {
    const source = '<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><root>&xxe;</root>';
    const storage = storageFor(Buffer.from(source, 'utf8'), 'r1', 'application/xml');
    const model = await new TextEngine().openModel(file('data.xml', 'application/xml'), { storage: storage as never, storageRevision: 'r1' });
    expect(model).toMatchObject({ parseError: 'DOCTYPE and external entities are not supported.', content: source, editable: true });
  });

  it('bounds deeply nested JSON as a safe source preview', async () => {
    const source = `${'{'.repeat(101)}0${'}'.repeat(101)}`;
    const storage = storageFor(Buffer.from(source, 'utf8'), 'r1', 'application/json');
    const model = await new TextEngine().openModel(file('data.json', 'application/json'), { storage: storage as never, storageRevision: 'r1' });
    expect(model.parseError).toContain('deeply nested');
    await expect(new TextEngine().save(file('data.json', 'application/json'), { expectedRevision: 'r1', content: source }, { storage: storage as never, expectedRevision: 'r1' })).rejects.toThrow('deeply nested');
    expect(storage.replace).not.toHaveBeenCalled();
  });

  it('blocks invalid JSON and XML saves before StorageProvider.replace', async () => {
    const jsonStorage = storageFor(Buffer.from('{}'), 'r1', 'application/json');
    const xmlStorage = storageFor(Buffer.from('<root/>'), 'r1', 'application/xml');
    const engine = new TextEngine();
    await expect(engine.save(file('data.json', 'application/json'), { expectedRevision: 'r1', content: '{' }, { storage: jsonStorage as never, expectedRevision: 'r1' })).rejects.toThrow('JSON is not valid');
    await expect(engine.save(file('data.xml', 'application/xml'), { expectedRevision: 'r1', content: '<root>' }, { storage: xmlStorage as never, expectedRevision: 'r1' })).rejects.toThrow('XML is not well-formed');
    expect(jsonStorage.replace).not.toHaveBeenCalled();
    expect(xmlStorage.replace).not.toHaveBeenCalled();
  });

  it('round-trips edited text through replace and preserves BOM/CRLF', async () => {
    const storage = storageFor(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo', 'utf8')]), 'r1');
    const result = await new TextEngine().save(file('notes.txt', 'text/plain'), { expectedRevision: 'r1', content: 'one\ntwo\nthree' }, { storage: storage as never, expectedRevision: 'r1' });
    expect(result.storageRevision).toBe('r2');
    expect(storage.current()).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\r\ntwo\r\nthree', 'utf8')]));
    expect(result.model.content).toBe('one\r\ntwo\r\nthree');
  });

  it('round-trips valid JSON and XML source without auto-rewriting the saved source', async () => {
    const jsonStorage = storageFor(Buffer.from('{"value":1}', 'utf8'), 'r1', 'application/json');
    const xmlStorage = storageFor(Buffer.from('<root><value>1</value></root>', 'utf8'), 'r1', 'application/xml');
    const engine = new TextEngine();
    await engine.save(file('data.json', 'application/json'), { expectedRevision: 'r1', content: '{"value":2}' }, { storage: jsonStorage as never, expectedRevision: 'r1' });
    await engine.save(file('data.xml', 'application/xml'), { expectedRevision: 'r1', content: '<root>\n  <value>2</value>\n</root>' }, { storage: xmlStorage as never, expectedRevision: 'r1' });
    expect(jsonStorage.current().toString('utf8')).toBe('{"value":2}');
    expect(xmlStorage.current().toString('utf8')).toBe('<root>\n  <value>2</value>\n</root>');
  });
});
