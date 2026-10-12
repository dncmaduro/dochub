import { unzipSync } from "fflate";
import { Readable } from "node:stream";
import type { StorageProvider, StorageObjectRef } from "../../storage/storage-provider.js";
import { FileEngineError } from "../file-engine.errors.js";

export const DOCX_LIMITS = {
  compressedBytes: 50 * 1024 * 1024,
  decompressedBytes: 100 * 1024 * 1024,
  entryBytes: 25 * 1024 * 1024,
  xmlEntryBytes: 10 * 1024 * 1024,
  maxEntries: 2_000,
  maxMediaEntries: 256,
  maxDocumentBlocks: 50_000,
} as const;

export type DocxFailureKind = "source" | "resource-limit" | "corrupt";

export class DocxPackageError extends FileEngineError {
  readonly expected = true;

  constructor(
    message: string,
    readonly failureKind: DocxFailureKind = "corrupt",
  ) {
    super(message, `DOCX_${failureKind.toUpperCase()}`);
  }
}

export interface DocxPackageEntry {
  path: string;
  bytes: Uint8Array;
}

function safeEntryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const directory = normalized.endsWith("/");
  const comparable = directory ? normalized.slice(0, -1) : normalized;
  if (
    comparable.startsWith("/") ||
    /^[A-Za-z]:\//.test(comparable) ||
    comparable.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new DocxPackageError("DOCX package contains an unsafe ZIP path", "corrupt");
  }
  return directory ? `${comparable}/` : comparable;
}

async function readBoundedStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "number" ? Buffer.from([chunk]) : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maxBytes) throw new DocxPackageError("DOCX source exceeds the package limit", "resource-limit");
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
}

export class DocxPackageReader {
  private constructor(private readonly entries: ReadonlyMap<string, Uint8Array>) {}

  static async fromStorage(storage: StorageProvider, ref: StorageObjectRef): Promise<DocxPackageReader> {
    return DocxPackageReader.fromBytes(await readDocxStorageBytes(storage, ref));
  }

  /** Reads only the bounded original package bytes; callers own any patch/rebuild step. */
  static async readStorageBytes(storage: StorageProvider, ref: StorageObjectRef): Promise<Buffer> {
    return readDocxStorageBytes(storage, ref);
  }

  private static fromEntries(entries: ReadonlyMap<string, Uint8Array>): DocxPackageReader {
    return new DocxPackageReader(entries);
  }

  static fromBytes(bytes: Uint8Array): DocxPackageReader {
    if (bytes.byteLength > DOCX_LIMITS.compressedBytes) {
      throw new DocxPackageError("DOCX source exceeds the package limit", "resource-limit");
    }
    const entries = new Map<string, Uint8Array>();
    let entryCount = 0;
    let decompressedTotal = 0;
    let mediaCount = 0;
    try {
      const unzipped = unzipSync(bytes, {
        filter: (info) => {
          entryCount += 1;
          if (entryCount > DOCX_LIMITS.maxEntries) {
            throw new DocxPackageError("DOCX package contains too many entries", "resource-limit");
          }
          const path = safeEntryPath(info.name);
          if (info.originalSize > DOCX_LIMITS.entryBytes) {
            throw new DocxPackageError("DOCX package entry exceeds the entry limit", "resource-limit");
          }
          decompressedTotal += info.originalSize;
          if (decompressedTotal > DOCX_LIMITS.decompressedBytes) {
            throw new DocxPackageError("DOCX package exceeds the decompressed size limit", "resource-limit");
          }
          if (path.startsWith("word/media/")) {
            mediaCount += 1;
            if (mediaCount > DOCX_LIMITS.maxMediaEntries) {
              throw new DocxPackageError("DOCX package contains too many media entries", "resource-limit");
            }
          }
          return !path.endsWith("/");
        },
      });
      for (const [path, value] of Object.entries(unzipped)) {
        entries.set(safeEntryPath(path), value);
      }
    } catch (error) {
      if (error instanceof DocxPackageError) throw error;
      throw new DocxPackageError("DOCX package could not be read", "corrupt");
    }
    if (!entries.has("word/document.xml")) throw new DocxPackageError("DOCX document part is missing", "corrupt");
    return DocxPackageReader.fromEntries(entries);
  }

  /** Package entries are returned as immutable byte views for a controlled rebuild. */
  allEntries(): ReadonlyMap<string, Uint8Array> {
    return this.entries;
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  entry(path: string): DocxPackageEntry | null {
    const bytes = this.entries.get(path);
    return bytes ? { path, bytes } : null;
  }

  text(path: string, maxBytes = DOCX_LIMITS.xmlEntryBytes): string {
    const value = this.entry(path);
    if (!value) throw new DocxPackageError(`DOCX part is missing: ${path}`, "corrupt");
    if (value.bytes.byteLength > maxBytes) throw new DocxPackageError("DOCX XML part exceeds the part limit", "resource-limit");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
    } catch {
      throw new DocxPackageError("DOCX XML part is not valid UTF-8", "corrupt");
    }
  }

  resolveTarget(sourcePart: string, target: string): string | null {
    if (!target || target.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
    const base = sourcePart.split("/").slice(0, -1);
    const parts = [...base, ...target.replaceAll("\\", "/").split("/")];
    const result: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (!result.length) return null;
        result.pop();
      } else {
        result.push(part);
      }
    }
    const resolved = result.join("/");
    return resolved && this.entries.has(resolved) ? resolved : null;
  }
}

async function readDocxStorageBytes(storage: StorageProvider, ref: StorageObjectRef): Promise<Buffer> {
  let content;
  try {
    content = await storage.openRead(ref);
  } catch {
    throw new DocxPackageError("DOCX source is unavailable", "source");
  }
  if (!content?.stream || !content.metadata) throw new DocxPackageError("DOCX source is unavailable", "source");
  if (content.metadata.sizeBytes != null && content.metadata.sizeBytes > BigInt(DOCX_LIMITS.compressedBytes)) {
    content.stream.destroy();
    if (content.cleanup) await content.cleanup().catch(() => undefined);
    throw new DocxPackageError("DOCX source exceeds the package limit", "resource-limit");
  }
  let bytes: Buffer;
  try {
    bytes = await readBoundedStream(content.stream, DOCX_LIMITS.compressedBytes);
  } finally {
    if (content.cleanup) await content.cleanup().catch(() => undefined);
  }
  return bytes;
}

export async function openDocxPackage(storage: StorageProvider, ref: StorageObjectRef): Promise<DocxPackageReader> {
  return DocxPackageReader.fromStorage(storage, ref);
}
