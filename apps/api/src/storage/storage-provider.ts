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

/** Opaque optimistic-concurrency marker returned by a storage provider. */
export type StorageRevision = string;

/** Opaque provider handle for an immutable historical version. */
export interface StorageVersionRef {
  provider: StorageProviderName;
  versionId: string;
}

export interface StorageVersionMetadata {
  ref: StorageVersionRef;
  storageRevision: StorageRevision;
  mimeType: string;
  sizeBytes: bigint | null;
  checksum?: string;
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

/** Optional historical-version capability; ordinary reads and writes do not depend on it. */
export interface VersionedStorageProvider {
  getCurrentVersion(ref: StorageObjectRef): Promise<StorageVersionMetadata>;
  preserveVersion(ref: StorageObjectRef, versionRef: StorageVersionRef): Promise<StorageVersionMetadata>;
  openVersion(ref: StorageObjectRef, versionRef: StorageVersionRef, options?: StorageReadOptions): Promise<StorageReadResult>;
  releaseVersion?(ref: StorageObjectRef, versionRef: StorageVersionRef): Promise<void>;
}

export function asVersionedStorageProvider(provider: StorageProvider): VersionedStorageProvider {
  if (!('getCurrentVersion' in provider) || typeof provider.getCurrentVersion !== 'function') {
    throw new Error('Storage provider does not support historical versions');
  }
  return provider as StorageProvider & VersionedStorageProvider;
}
