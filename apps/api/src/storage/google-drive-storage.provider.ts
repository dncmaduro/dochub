import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  StorageAccessError,
  StorageConflictError,
  StorageObjectNotFoundError,
  StorageProviderUnavailableError,
  StorageError,
} from './storage.errors.js';
import type {
  PutObjectInput,
  ReplaceObjectInput,
  ReplacePrecondition,
  StorageByteRange,
  StorageObjectRef,
  StorageProvider,
  StorageReadOptions,
  StorageReadResult,
  StoredObject,
  StoredObjectMetadata,
  StorageVersionMetadata,
  StorageVersionRef,
  VersionedStorageProvider,
} from './storage-provider.js';
import { DriveProviderError, type DriveApiFile, type DriveContent } from '../drive/google-drive.provider.js';
import { DriveService } from '../drive/drive.service.js';

const GOOGLE_DRIVE: StorageObjectRef['provider'] = 'GOOGLE_DRIVE';

function extensionFor(filename: string | undefined): string {
  const extension = filename?.match(/\.[a-z0-9]{1,16}$/i)?.[0]?.toLowerCase();
  return extension ?? '';
}

function ref(objectId: string): StorageObjectRef {
  return { provider: GOOGLE_DRIVE, objectId };
}

function metadata(file: DriveApiFile, fallbackMimeType?: string): StoredObjectMetadata {
  return {
    provider: GOOGLE_DRIVE,
    objectId: file.id,
    mimeType: file.mimeType ?? fallbackMimeType ?? 'application/octet-stream',
    sizeBytes: file.size ? BigInt(file.size) : null,
    checksum: file.md5Checksum,
    revision: file.version,
    modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : undefined,
  };
}

function rangeHeader(range: StorageByteRange): string {
  return `bytes=${range.start}-${range.end ?? ''}`;
}

function assertReference(reference: StorageObjectRef): void {
  if (reference.provider !== GOOGLE_DRIVE || !reference.objectId.trim()) {
    throw new StorageObjectNotFoundError('Storage object reference is invalid');
  }
}

@Injectable()
export class GoogleDriveStorageProvider implements StorageProvider, VersionedStorageProvider {
  constructor(private readonly drive: DriveService) {}

  async put(input: PutObjectInput): Promise<StoredObject> {
    try {
      const file = await this.drive.putStorageObject(
        `${randomUUID()}${extensionFor(input.filename)}`,
        input.mimeType,
        input.stream,
        input.signal,
      );
      return { ref: ref(file.id), metadata: metadata(file, input.mimeType) };
    } catch (error) {
      throw this.mapError(error, 'Unable to store object');
    }
  }

  async openRead(
    reference: StorageObjectRef,
    options?: StorageReadOptions,
  ): Promise<StorageReadResult> {
    assertReference(reference);
    try {
      const content = await this.drive.openStorageObject(
        reference.objectId,
        options?.range ? rangeHeader(options.range) : undefined,
      );
      return this.readResult(reference, content);
    } catch (error) {
      throw this.mapError(error, 'Unable to read object');
    }
  }

  async replace(
    reference: StorageObjectRef,
    input: ReplaceObjectInput,
    precondition?: ReplacePrecondition,
  ): Promise<StoredObject> {
    assertReference(reference);
    try {
      if (precondition?.expectedRevision !== undefined) {
        const current = await this.stat(reference);
        if (current.revision !== precondition.expectedRevision) {
          throw new StorageConflictError('Storage object revision has changed');
        }
      }
      const file = await this.drive.replaceStorageObject(
        reference.objectId,
        input.mimeType,
        input.stream,
        input.signal,
      );
      return { ref: reference, metadata: metadata(file, input.mimeType) };
    } catch (error) {
      if (error instanceof StorageConflictError) throw error;
      throw this.mapError(error, 'Unable to replace object');
    }
  }

  async delete(reference: StorageObjectRef): Promise<void> {
    assertReference(reference);
    try {
      await this.drive.deleteStorageObject(reference.objectId);
    } catch (error) {
      throw this.mapError(error, 'Unable to delete object');
    }
  }

  async stat(reference: StorageObjectRef): Promise<StoredObjectMetadata> {
    assertReference(reference);
    try {
      return metadata(
        await this.drive.statStorageObject(reference.objectId),
      );
    } catch (error) {
      throw this.mapError(error, 'Unable to inspect object');
    }
  }

  async getCurrentVersion(reference: StorageObjectRef): Promise<StorageVersionMetadata> {
    assertReference(reference);
    try {
      const file = await this.drive.statStorageObject(reference.objectId);
      if (!file.headRevisionId || !file.version) {
        throw new StorageProviderUnavailableError('Storage provider did not return version metadata');
      }
      return this.versionMetadata(reference, {
        id: file.headRevisionId,
        mimeType: file.mimeType,
        size: file.size,
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
      }, file.version);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw this.mapError(error, 'Unable to inspect storage version');
    }
  }

  async preserveVersion(reference: StorageObjectRef, versionRef: StorageVersionRef): Promise<StorageVersionMetadata> {
    assertReference(reference);
    if (versionRef.provider !== GOOGLE_DRIVE || !versionRef.versionId.trim()) {
      throw new StorageObjectNotFoundError('Storage version reference is invalid');
    }
    try {
      const revision = await this.drive.updateStorageRevision(reference.objectId, versionRef.versionId, true);
      return this.versionMetadata(reference, revision, undefined);
    } catch (error) {
      throw this.mapError(error, 'Unable to preserve storage version');
    }
  }

  async openVersion(reference: StorageObjectRef, versionRef: StorageVersionRef, options?: StorageReadOptions): Promise<StorageReadResult> {
    assertReference(reference);
    if (versionRef.provider !== GOOGLE_DRIVE || !versionRef.versionId.trim()) {
      throw new StorageObjectNotFoundError('Storage version reference is invalid');
    }
    try {
      const content = await this.drive.openStorageRevision(reference.objectId, versionRef.versionId, options?.range ? rangeHeader(options.range) : undefined);
      return this.readResult(reference, content);
    } catch (error) {
      throw this.mapError(error, 'Unable to read historical version');
    }
  }

  async releaseVersion(reference: StorageObjectRef, versionRef: StorageVersionRef): Promise<void> {
    assertReference(reference);
    if (versionRef.provider !== GOOGLE_DRIVE || !versionRef.versionId.trim()) {
      throw new StorageObjectNotFoundError('Storage version reference is invalid');
    }
    try {
      await this.drive.deleteStorageRevision(reference.objectId, versionRef.versionId);
    } catch (error) {
      throw this.mapError(error, 'Unable to release historical version');
    }
  }

  private versionMetadata(reference: StorageObjectRef, revision: { id: string; mimeType?: string; size?: string; md5Checksum?: string; modifiedTime?: string }, storageRevision?: string): StorageVersionMetadata {
    if (!storageRevision) storageRevision = revision.id;
    return {
      ref: { provider: reference.provider, versionId: revision.id },
      storageRevision,
      mimeType: revision.mimeType ?? 'application/octet-stream',
      sizeBytes: revision.size ? BigInt(revision.size) : null,
      checksum: revision.md5Checksum,
      modifiedAt: revision.modifiedTime ? new Date(revision.modifiedTime) : undefined,
    };
  }

  private readResult(
    reference: StorageObjectRef,
    content: DriveContent,
  ): StorageReadResult {
    const sizeBytes = content.range
      ? BigInt(content.range.total)
      : content.sizeBytes;
    return {
      stream: content.stream,
      range: content.range,
      cleanup: content.cleanup,
      metadata: {
        provider: GOOGLE_DRIVE,
        objectId: reference.objectId,
        mimeType: content.mimeType,
        sizeBytes,
      },
    };
  }

  private mapError(error: unknown, message: string): Error {
    if (error instanceof StorageError) return error;
    if (error instanceof DriveProviderError) {
      if (error.status === 404) {
        return new StorageObjectNotFoundError('Storage object not found', {
          cause: error,
        });
      }
      if (error.kind === 'network' || error.kind === 'rate_limited') {
        return new StorageProviderUnavailableError(
          'Storage provider is temporarily unavailable',
          { cause: error },
        );
      }
      if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
        return new StorageAccessError('Storage access was denied', {
          cause: error,
        });
      }
    }
    return new StorageProviderUnavailableError(message, { cause: error });
  }
}
