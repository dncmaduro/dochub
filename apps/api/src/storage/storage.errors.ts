export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class StorageObjectNotFoundError extends StorageError {}

export class StorageAccessError extends StorageError {}

export class StorageConflictError extends StorageError {}

export class StorageProviderUnavailableError extends StorageError {}

export class StorageLimitError extends StorageError {}
