import { unzipSync } from 'fflate';
import { Readable } from 'node:stream';
import type { StorageObjectRef, StorageProvider } from '../../storage/storage-provider.js';
import { FileEngineError } from '../file-engine.errors.js';
import { SPREADSHEET_LIMITS } from './spreadsheet-limits.js';

export type XlsxFailureKind =
  | 'source'
  | 'package-read'
  | 'resource-limit'
  | 'model-limit'
  | 'workbook'
  | 'relationships'
  | 'worksheet'
  | 'styles'
  | 'shared-strings'
  | 'corrupt';

export class SpreadsheetPackageError extends FileEngineError {
  readonly expected = true;
  constructor(message: string, readonly failureKind: XlsxFailureKind = 'corrupt') {
    super(message, `XLSX_${failureKind.replaceAll('-', '_').toUpperCase()}`);
  }
}

export interface SpreadsheetPackageEntry { path: string; bytes: Uint8Array; }

function safePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const comparable = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (!comparable || comparable.startsWith('/') || /^[A-Za-z]:\//.test(comparable) || comparable.split('/').some((part) => part === '..' || part === '')) {
    throw new SpreadsheetPackageError('XLSX package contains an unsafe ZIP path');
  }
  return normalized.endsWith('/') ? `${comparable}/` : comparable;
}

async function readBounded(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'number' ? Buffer.from([chunk]) : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) throw new SpreadsheetPackageError('XLSX source exceeds the package limit', 'resource-limit');
      chunks.push(bytes);
    }
  } finally { stream.destroy(); }
  return Buffer.concat(chunks, total);
}

export class XlsxPackageReader {
  private constructor(private readonly entries: ReadonlyMap<string, Uint8Array>) {}

  static async fromStorage(storage: StorageProvider, ref: StorageObjectRef): Promise<XlsxPackageReader> {
    return this.fromBytes(await this.readStorageBytes(storage, ref));
  }

  static async readStorageBytes(storage: StorageProvider, ref: StorageObjectRef): Promise<Buffer> {
    let content;
    try { content = await storage.openRead(ref); } catch { throw new SpreadsheetPackageError('XLSX source is unavailable', 'source'); }
    if (!content?.stream || !content.metadata) throw new SpreadsheetPackageError('XLSX source is unavailable', 'source');
    if (content.metadata.sizeBytes !== null && content.metadata.sizeBytes > BigInt(SPREADSHEET_LIMITS.compressedBytes)) {
      content.stream.destroy();
      if (content.cleanup) await content.cleanup().catch(() => undefined);
      throw new SpreadsheetPackageError('XLSX source exceeds the package limit', 'resource-limit');
    }
    try { return await readBounded(content.stream, SPREADSHEET_LIMITS.compressedBytes); }
    finally { if (content.cleanup) await content.cleanup().catch(() => undefined); }
  }

  static fromBytes(bytes: Uint8Array): XlsxPackageReader {
    if (bytes.byteLength > SPREADSHEET_LIMITS.compressedBytes) throw new SpreadsheetPackageError('XLSX source exceeds the package limit', 'resource-limit');
    const entries = new Map<string, Uint8Array>();
    let count = 0;
    let total = 0;
    try {
      const unzipped = unzipSync(bytes, {
        filter: (info) => {
          count += 1;
          if (count > SPREADSHEET_LIMITS.maxEntries) throw new SpreadsheetPackageError('XLSX package contains too many entries', 'resource-limit');
          const path = safePath(info.name);
          if (info.originalSize > SPREADSHEET_LIMITS.entryBytes) throw new SpreadsheetPackageError('XLSX package entry exceeds the entry limit', 'resource-limit');
          total += info.originalSize;
          if (total > SPREADSHEET_LIMITS.decompressedBytes) throw new SpreadsheetPackageError('XLSX package exceeds the decompressed size limit', 'resource-limit');
          return !path.endsWith('/');
        },
      });
      for (const [path, value] of Object.entries(unzipped)) entries.set(safePath(path), value);
    } catch (error) {
      if (error instanceof SpreadsheetPackageError) throw error;
      throw new SpreadsheetPackageError('XLSX package could not be read', 'package-read');
    }
    if (!entries.has('xl/workbook.xml')) throw new SpreadsheetPackageError('XLSX workbook part is missing', 'workbook');
    if (!entries.has('xl/_rels/workbook.xml.rels')) throw new SpreadsheetPackageError('XLSX workbook relationships are missing', 'relationships');
    return new XlsxPackageReader(entries);
  }

  allEntries(): ReadonlyMap<string, Uint8Array> { return this.entries; }
  has(path: string): boolean { return this.entries.has(path); }
  entry(path: string): SpreadsheetPackageEntry | null { const bytes = this.entries.get(path); return bytes ? { path, bytes } : null; }
  text(path: string, maxBytes = SPREADSHEET_LIMITS.xmlEntryBytes): string {
    const entry = this.entry(path);
    if (!entry) throw new SpreadsheetPackageError(`XLSX part is missing: ${path}`);
    if (entry.bytes.byteLength > maxBytes) throw new SpreadsheetPackageError('XLSX XML part exceeds the part limit', 'resource-limit');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes); }
    catch { throw new SpreadsheetPackageError(`XLSX XML part is not valid UTF-8: ${path}`); }
  }
  resolveTarget(sourcePart: string, target: string): string | null {
    const normalizedTarget = target.trim().replaceAll('\\', '/');
    if (!normalizedTarget || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalizedTarget)) return null;
    const packageRootTarget = normalizedTarget.startsWith('/');
    const targetParts = (packageRootTarget ? normalizedTarget.slice(1) : normalizedTarget).split('/');
    const parts = [...(packageRootTarget ? [] : sourcePart.split('/').slice(0, -1)), ...targetParts];
    const result: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { if (!result.length) return null; result.pop(); } else result.push(part);
    }
    const resolved = result.join('/');
    return resolved && this.entries.has(resolved) ? resolved : null;
  }
}
