import {
  extensionFromFilename,
  isGenericMimeType,
  normalizeExtension,
  normalizeMimeType,
  storageContent,
  type FileDescriptor,
  type FileEngine,
  type FileEngineCapabilities,
  type FileEngineId,
  type FileEngineOpenContext,
  type FilePreviewContent,
  type FilePreviewResult,
} from '../file-engine.types.js';

export abstract class BaseFileEngine implements FileEngine {
  abstract readonly id: FileEngineId;
  abstract readonly priority: number;
  protected abstract readonly mimeTypes: ReadonlySet<string>;
  protected abstract readonly extensions: ReadonlySet<string>;
  protected readonly defaultCapabilities: FileEngineCapabilities = {
    preview: true,
    edit: false,
    download: true,
    textExtraction: false,
    thumbnail: false,
  };

  matches(file: FileDescriptor): boolean {
    const mimeType = normalizeMimeType(file.mimeType);
    if (!isGenericMimeType(mimeType)) return this.matchesMime(mimeType);
    return this.matchesExtension(file.extension ?? extensionFromFilename(file.name) ?? '');
  }

  matchesMime(mimeType: string): boolean {
    return this.mimeTypes.has(normalizeMimeType(mimeType));
  }

  matchesExtension(extension: string): boolean {
    return this.extensions.has(normalizeExtension(extension));
  }

  capabilities(_file: FileDescriptor): FileEngineCapabilities {
    return this.defaultCapabilities;
  }

  abstract openPreview(file: FileDescriptor): Promise<FilePreviewResult>;

  protected async openStoredContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent> {
    if (!file.storageRef) throw new Error('A storage reference is required for this preview.');
    const content = await context.storage.openRead(
      file.storageRef,
      context.range ? { range: context.range } : undefined,
    );
    return storageContent({
      ...content,
      metadata: {
        ...content.metadata,
        mimeType: content.metadata.mimeType || file.mimeType || 'application/octet-stream',
      },
    });
  }
}
