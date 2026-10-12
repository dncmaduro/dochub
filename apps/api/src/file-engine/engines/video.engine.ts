import { BaseFileEngine } from './base.engine.js';
import { extensionFromFilename, isGenericMimeType, type FileDescriptor, type FilePreviewResult } from '../file-engine.types.js';

export class VideoEngine extends BaseFileEngine {
  readonly id = 'VIDEO' as const;
  readonly priority = 30;
  protected readonly mimeTypes = new Set(['video/mp4', 'video/webm']);
  protected readonly extensions = new Set(['.mp4', '.webm']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    const extension = file.extension ?? extensionFromFilename(file.name);
    const fallback = extension === '.webm' ? 'video/webm' : 'video/mp4';
    return { kind: 'video', mimeType: isGenericMimeType(file.mimeType) ? fallback : file.mimeType };
  }

  openContent = this.openStoredContent.bind(this);
}
