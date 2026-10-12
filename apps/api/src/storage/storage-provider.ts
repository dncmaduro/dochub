import type { Readable } from 'node:stream';

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/** Provider identities are deliberately finite and opaque to product code. */
export type StorageProviderName = 'GOOGLE_DRIVE';

export interface StorageObjectRef {
  provider: StorageProviderName;
  objectId: string;
}

export interface StoredObjectMetadata {
  provider: StorageProviderName;
  objectId: string;
  mimeType: string;
  sizeBytes: bigint | null;
  checksum?: string;
  /** Google Drive `version`; see file-storage-and-engine-architecture.md. */
  revision?: string;
  modifiedAt?: Date;
}

export interface StoredObject {
  ref: StorageObjectRef;
  metadata: StoredObjectMetadata;
}

export interface StorageByteRange {
  start: number;
  end?: number;
}

export interface StorageReadOptions {
  range?: StorageByteRange;
  signal?: AbortSignal;
}

export interface StorageReadResult {
  stream: Readable;
  metadata: StoredObjectMetadata;
  range: { start: number; end: number; total: number } | null;
  cleanup?: () => Promise<void>;
}

export interface PutObjectInput {
  stream: Readable;
  mimeType: string;
  /** Logical filename used only to select a safe extension for new objects. */
  filename?: string;
  signal?: AbortSignal;
}

export interface ReplaceObjectInput {
  stream: Readable;
  mimeType: string;
  signal?: AbortSignal;
}

export interface ReplacePrecondition {
  expectedRevision?: string;
}

/** Physical byte storage contract. Authorization belongs to callers. */
export interface StorageProvider {
  put(input: PutObjectInput): Promise<StoredObject>;
  openRead(
    ref: StorageObjectRef,
    options?: StorageReadOptions,
  ): Promise<StorageReadResult>;
  replace(
    ref: StorageObjectRef,
    input: ReplaceObjectInput,
    precondition?: ReplacePrecondition,
  ): Promise<StoredObject>;
  delete(ref: StorageObjectRef): Promise<void>;
  stat(ref: StorageObjectRef): Promise<StoredObjectMetadata>;
}
