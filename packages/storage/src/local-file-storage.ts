import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  InvalidStorageKey,
  StorageConfigurationError,
  StorageError,
  StorageObjectAlreadyExists,
  StorageObjectNotFound,
} from "./storage.errors.js";
import { validateStorageKey } from "./storage-key.js";
import type {
  StorageObjectStat,
  StorageReadOptions,
  StorageService,
} from "./storage.types.js";

export class LocalFileStorage implements StorageService {
  private readonly rootDirectory: string;
  private readonly rootReady: Promise<void>;

  constructor(rootDirectory: string) {
    if (
      typeof rootDirectory !== "string" ||
      rootDirectory.trim().length === 0 ||
      !path.isAbsolute(rootDirectory)
    ) {
      throw new StorageConfigurationError(
        "Local storage root must be a non-empty absolute path",
      );
    }
    this.rootDirectory = path.resolve(rootDirectory);
    this.rootReady = mkdir(this.rootDirectory, { recursive: true })
      .then(async () => {
        const metadata = await lstat(this.rootDirectory);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new StorageConfigurationError(
            "Local storage root must be a real directory",
          );
        }
      })
      .catch((cause: unknown) => {
        throw new StorageConfigurationError(
          "Unable to initialize local storage",
          {
            cause,
          },
        );
      });
  }

  async putStream(storageKey: string, readable: Readable): Promise<void> {
    const { objectPath } = await this.prepareParent(storageKey);
    const temporaryPath = path.join(
      path.dirname(objectPath),
      `.${path.basename(objectPath)}.${randomUUID()}.partial`,
    );
    let published = false;
    try {
      const writable = createWriteStream(temporaryPath, {
        flags: "wx",
        flush: true,
      });
      await pipeline(readable, writable);
      // link() publishes only a fully written object and fails atomically when
      // an immutable storage key already exists.
      await link(temporaryPath, objectPath);
      published = true;
      await unlink(temporaryPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (published) await unlink(objectPath).catch(() => undefined);
      if (this.errorCode(error) === "EEXIST") {
        throw new StorageObjectAlreadyExists("Storage object already exists", {
          cause: error,
        });
      }
      throw new StorageError("Unable to store object", { cause: error });
    }
  }

  async promote(stagedKey: string, storageKey: string): Promise<void> {
    const { objectPath: stagedPath } = await this.prepareExisting(stagedKey);
    const { objectPath } = await this.prepareParent(storageKey);
    try {
      // The stage and final key live on the same storage volume. A hard link
      // publishes the already flushed bytes atomically without copying them.
      // Keep the stage until the metadata transaction commits so a failed
      // commit can be retried safely.
      await link(stagedPath, objectPath);
    } catch (error) {
      if (this.errorCode(error) === "EEXIST") {
        throw new StorageObjectAlreadyExists("Storage object already exists", {
          cause: error,
        });
      }
      throw new StorageError("Unable to promote staged object", { cause: error });
    }
  }

  async openReadStream(
    storageKey: string,
    options?: StorageReadOptions,
  ): Promise<Readable> {
    const { objectPath } = await this.prepareExisting(storageKey);
    this.validateRange(options);
    return createReadStream(objectPath, options);
  }

  async stat(storageKey: string): Promise<StorageObjectStat> {
    const { objectPath } = await this.prepareExisting(storageKey);
    const metadata = await this.lstatObject(objectPath);
    return { sizeBytes: metadata.size, modifiedAt: metadata.mtime };
  }

  async exists(storageKey: string): Promise<boolean> {
    const { objectPath } = await this.prepareExistingPath(storageKey);
    try {
      const metadata = await lstat(objectPath, { bigint: true });
      return metadata.isFile();
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") {
        return false;
      }
      throw new StorageError("Unable to inspect storage object", {
        cause: error,
      });
    }
  }

  async delete(storageKey: string): Promise<void> {
    const { objectPath } = await this.prepareExistingPath(storageKey);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(objectPath);
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") {
        return;
      }
      throw new StorageError("Unable to inspect storage object", {
        cause: error,
      });
    }
    if (!metadata.isFile()) {
      throw new StorageError("Storage object is not a regular file");
    }
    try {
      await unlink(objectPath);
    } catch (error) {
      if (this.errorCode(error) !== "ENOENT") {
        throw new StorageError("Unable to delete storage object", {
          cause: error,
        });
      }
    }
  }

  private async prepareParent(storageKey: string): Promise<{
    objectPath: string;
  }> {
    await this.rootReady;
    const key = validateStorageKey(storageKey);
    const objectPath = this.resolveContainedPath(key);
    await this.ensureParentDirectories(key);
    return { objectPath };
  }

  private async prepareExisting(
    storageKey: string,
  ): Promise<{ objectPath: string }> {
    const { objectPath } = await this.prepareExistingPath(storageKey);
    await this.lstatObject(objectPath);
    return { objectPath };
  }

  private async prepareExistingPath(
    storageKey: string,
  ): Promise<{ objectPath: string }> {
    await this.rootReady;
    const key = validateStorageKey(storageKey);
    const objectPath = this.resolveContainedPath(key);
    await this.assertSafeParentDirectories(key);
    return { objectPath };
  }

  private resolveContainedPath(key: string): string {
    const objectPath = path.resolve(this.rootDirectory, ...key.split("/"));
    const relative = path.relative(this.rootDirectory, objectPath);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new InvalidStorageKey("Invalid storage key");
    }
    return objectPath;
  }

  private async ensureParentDirectories(key: string): Promise<void> {
    const segments = key.split("/");
    let current = this.rootDirectory;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new StorageError("Unsafe storage directory");
        }
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        if (this.errorCode(error) !== "ENOENT") {
          throw new StorageError("Unable to prepare storage directory", {
            cause: error,
          });
        }
        await mkdir(current);
      }
    }
  }

  private async assertSafeParentDirectories(key: string): Promise<void> {
    const segments = key.split("/");
    let current = this.rootDirectory;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new StorageError("Unsafe storage directory");
        }
      } catch (error) {
        if (error instanceof StorageError) {
          throw error;
        }
        if (this.errorCode(error) === "ENOENT") {
          return;
        }
        throw new StorageError("Unable to inspect storage directory", {
          cause: error,
        });
      }
    }
  }

  private async lstatObject(objectPath: string) {
    try {
      const metadata = await lstat(objectPath, { bigint: true });
      if (!metadata.isFile()) {
        throw new StorageError("Storage object is not a regular file");
      }
      return metadata;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      if (this.errorCode(error) === "ENOENT") {
        throw new StorageObjectNotFound("Storage object not found", {
          cause: error,
        });
      }
      throw new StorageError("Unable to inspect storage object", {
        cause: error,
      });
    }
  }

  private validateRange(options: StorageReadOptions | undefined): void {
    if (!options) {
      return;
    }
    const { start, end } = options;
    if (
      (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < 0)) ||
      (start !== undefined && end !== undefined && end < start)
    ) {
      throw new StorageError("Invalid storage read range");
    }
  }

  private errorCode(error: unknown): string | undefined {
    return error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
      ? error.code
      : undefined;
  }
}
