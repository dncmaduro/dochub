import { BaseFileEngine } from './base.engine.js';
import { extensionFromFilename, isGenericMimeType, type FileDescriptor, type FilePreviewResult } from '../file-engine.types.js';

export class AudioEngine extends BaseFileEngine {
  readonly id = 'AUDIO' as const;
  readonly priority = 20;
  protected readonly mimeTypes = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/webm']);
  protected readonly extensions = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.webm']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    const extension = file.extension ?? extensionFromFilename(file.name);
    const fallback = extension === '.wav' ? 'audio/wav' : extension === '.ogg' || extension === '.oga' ? 'audio/ogg' : extension === '.webm' ? 'audio/webm' : extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
    return { kind: 'audio', mimeType: isGenericMimeType(file.mimeType) ? fallback : file.mimeType };
  }

  openContent = this.openStoredContent.bind(this);
}
