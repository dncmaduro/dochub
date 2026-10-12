import { BaseFileEngine } from './base.engine.js';
import { extensionFromFilename, isGenericMimeType, type FileDescriptor, type FilePreviewResult } from '../file-engine.types.js';

export class ImageEngine extends BaseFileEngine {
  readonly id = 'IMAGE' as const;
  readonly priority = 50;
  protected readonly mimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  protected readonly extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    const extension = file.extension ?? extensionFromFilename(file.name);
    const fallback = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : 'image/jpeg';
    return { kind: 'image', mimeType: isGenericMimeType(file.mimeType) ? fallback : file.mimeType };
  }

  openContent = this.openStoredContent.bind(this);
}
