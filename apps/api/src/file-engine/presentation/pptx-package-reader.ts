import { unzipSync } from 'fflate';
import { Readable } from 'node:stream';
import type { StorageObjectRef, StorageProvider } from '../../storage/storage-provider.js';
import { FileEngineError } from '../file-engine.errors.js';
import { PRESENTATION_LIMITS } from './presentation-limits.js';

export type PresentationFailureKind = 'source' | 'resource-limit' | 'corrupt';

export class PresentationPackageError extends FileEngineError {
  readonly expected = true;

  constructor(message: string, readonly failureKind: PresentationFailureKind = 'corrupt') {
    super(message, `PPTX_${failureKind.toUpperCase()}`);
  }
}

function safeEntryPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const directory = normalized.endsWith('/');
  const comparable = directory ? normalized.slice(0, -1) : normalized;
  if (comparable.startsWith('/') || /^[A-Za-z]:\//u.test(comparable) || comparable.split('/').some((part) => part === '..' || part === '')) {
    throw new PresentationPackageError('PPTX package contains an unsafe ZIP path');
  }
  return directory ? `${comparable}/` : comparable;
}

async function readBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'number' ? Buffer.from([chunk]) : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) throw new PresentationPackageError('PPTX source exceeds the package limit', 'resource-limit');
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

export interface PresentationPackageEntry { path: string; bytes: Uint8Array }

export class PptxPackageReader {
  private constructor(private readonly entries: ReadonlyMap<string, Uint8Array>) {}

  static async fromStorage(storage: StorageProvider, ref: StorageObjectRef): Promise<PptxPackageReader> {
    return PptxPackageReader.fromBytes(await readPptxStorageBytes(storage, ref));
  }

  static async readStorageBytes(storage: StorageProvider, ref: StorageObjectRef): Promise<Buffer> {
    return readPptxStorageBytes(storage, ref);
  }

  static fromBytes(bytes: Uint8Array): PptxPackageReader {
    if (bytes.byteLength > PRESENTATION_LIMITS.compressedBytes) throw new PresentationPackageError('PPTX source exceeds the package limit', 'resource-limit');
    const entries = new Map<string, Uint8Array>();
    let count = 0;
    let total = 0;
    let media = 0;
    try {
      const unzipped = unzipSync(bytes, {
        filter: (info) => {
          count += 1;
          if (count > PRESENTATION_LIMITS.maxEntries) throw new PresentationPackageError('PPTX package contains too many entries', 'resource-limit');
          const path = safeEntryPath(info.name);
          if (info.originalSize > PRESENTATION_LIMITS.entryBytes) throw new PresentationPackageError('PPTX package entry exceeds the entry limit', 'resource-limit');
          total += info.originalSize;
          if (total > PRESENTATION_LIMITS.decompressedBytes) throw new PresentationPackageError('PPTX package exceeds the decompressed size limit', 'resource-limit');
          if (path.startsWith('ppt/media/')) {
            media += 1;
            if (media > PRESENTATION_LIMITS.maxMediaEntries || info.originalSize > PRESENTATION_LIMITS.maxMediaEntryBytes) throw new PresentationPackageError('PPTX media exceeds the package limit', 'resource-limit');
          }
          return !path.endsWith('/');
        },
      });
      for (const [path, value] of Object.entries(unzipped)) entries.set(safeEntryPath(path), value);
    } catch (error) {
      if (error instanceof PresentationPackageError) throw error;
      throw new PresentationPackageError('PPTX package could not be read', 'corrupt');
    }
    if (!entries.has('ppt/presentation.xml') || !entries.has('ppt/_rels/presentation.xml.rels')) throw new PresentationPackageError('PPTX presentation parts are missing');
    return new PptxPackageReader(entries);
  }

  allEntries(): ReadonlyMap<string, Uint8Array> { return this.entries; }
  has(path: string): boolean { return this.entries.has(path); }
  entry(path: string): PresentationPackageEntry | null {
    const bytes = this.entries.get(path);
    return bytes ? { path, bytes } : null;
  }
  text(path: string, maxBytes = PRESENTATION_LIMITS.xmlEntryBytes): string {
    const entry = this.entry(path);
    if (!entry) throw new PresentationPackageError(`PPTX part is missing: ${path}`);
    if (entry.bytes.byteLength > maxBytes) throw new PresentationPackageError('PPTX XML part exceeds the part limit', 'resource-limit');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes); }
    catch { throw new PresentationPackageError('PPTX XML part is not valid UTF-8'); }
  }
  resolveTarget(sourcePart: string, target: string): string | null {
    if (!target || target.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) return null;
    const parts = [...sourcePart.split('/').slice(0, -1), ...target.replaceAll('\\', '/').split('/')];
    const result: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!result.length) return null; result.pop(); }
      else result.push(part);
    }
    const resolved = result.join('/');
    return resolved && this.entries.has(resolved) ? resolved : null;
  }
}

async function readPptxStorageBytes(storage: StorageProvider, ref: StorageObjectRef): Promise<Buffer> {
  let content;
  try { content = await storage.openRead(ref); }
  catch { throw new PresentationPackageError('PPTX source is unavailable', 'source'); }
  if (!content?.stream || !content.metadata) throw new PresentationPackageError('PPTX source is unavailable', 'source');
  if (content.metadata.sizeBytes != null && content.metadata.sizeBytes > BigInt(PRESENTATION_LIMITS.compressedBytes)) {
    content.stream.destroy();
    if (content.cleanup) await content.cleanup().catch(() => undefined);
    throw new PresentationPackageError('PPTX source exceeds the package limit', 'resource-limit');
  }
  try { return await readBounded(content.stream, PRESENTATION_LIMITS.compressedBytes); }
  finally { if (content.cleanup) await content.cleanup().catch(() => undefined); }
}
