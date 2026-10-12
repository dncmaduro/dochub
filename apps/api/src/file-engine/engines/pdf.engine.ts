import { BaseFileEngine } from './base.engine.js';
import type { FileDescriptor, FilePreviewResult } from '../file-engine.types.js';

export class PdfEngine extends BaseFileEngine {
  readonly id = 'PDF' as const;
  readonly priority = 60;
  protected readonly mimeTypes = new Set(['application/pdf']);
  protected readonly extensions = new Set(['.pdf']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    return { kind: 'pdf', mimeType: file.mimeType === 'application/pdf' ? file.mimeType : 'application/pdf' };
  }

  openContent = this.openStoredContent.bind(this);
}
