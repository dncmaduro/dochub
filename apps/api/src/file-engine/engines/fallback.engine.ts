import { BaseFileEngine } from './base.engine.js';
import type { FileDescriptor, FileEngineCapabilities, FilePreviewResult } from '../file-engine.types.js';

export class FallbackEngine extends BaseFileEngine {
  readonly id = 'FALLBACK' as const;
  readonly priority = -1;
  protected readonly mimeTypes = new Set<string>();
  protected readonly extensions = new Set<string>();

  matches(_file: FileDescriptor): boolean {
    return true;
  }

  capabilities(_file: FileDescriptor): FileEngineCapabilities {
    return { preview: false, edit: false, download: true, textExtraction: false, thumbnail: false };
  }

  async openPreview(_file: FileDescriptor): Promise<FilePreviewResult> {
    return { kind: 'unavailable', mimeType: null, reason: 'unsupported' };
  }

  /** Download remains available even when no renderer is available. */
  openContent = this.openStoredContent.bind(this);
}
