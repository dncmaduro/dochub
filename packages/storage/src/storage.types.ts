import type { Readable } from 'node:stream';

export interface StorageReadOptions {
  start?: number;
  end?: number;
}

export interface StorageObjectStat {
  sizeBytes: bigint;
  modifiedAt: Date;
}

/** Backend-neutral immutable binary-object storage contract. */
export interface StorageService {
  putStream(storageKey: string, readable: Readable): Promise<void>;
  openReadStream(storageKey: string, options?: StorageReadOptions): Promise<Readable>;
  stat(storageKey: string): Promise<StorageObjectStat>;
  exists(storageKey: string): Promise<boolean>;
  delete(storageKey: string): Promise<void>;
}
