import { BaseFileEngine } from './base.engine.js';
import { isGenericMimeType, type FileDescriptor, type FilePreviewResult } from '../file-engine.types.js';

export class TextEngine extends BaseFileEngine {
  readonly id = 'TEXT' as const;
  readonly priority = 40;
  protected readonly mimeTypes = new Set([
    'text/plain',
    'text/markdown',
    'text/x-markdown',
    'application/json',
    'application/xml',
    'text/xml',
  ]);
  protected readonly extensions = new Set(['.txt', '.md', '.markdown', '.json', '.xml']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    return { kind: 'text', mimeType: isGenericMimeType(file.mimeType) ? 'text/plain' : file.mimeType };
  }

  openContent = this.openStoredContent.bind(this);
}
