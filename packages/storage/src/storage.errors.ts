export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidStorageKey extends StorageError {}

export class StorageObjectNotFound extends StorageError {}

export class StorageObjectAlreadyExists extends StorageError {}

export class StorageConfigurationError extends StorageError {}
