import { BaseFileEngine } from './base.engine.js';
import type {
  FileDescriptor,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export class DocumentEngine extends BaseFileEngine {
  readonly id = 'DOCUMENT' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([
    'application/msword',
    'application/vnd.ms-word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]);
  protected readonly extensions = new Set(['.doc', '.docx']);

  async openPreview(_file: FileDescriptor): Promise<FilePreviewResult> {
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }

  async openContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent> {
    if (!context.openLibreOfficePreview) throw new Error('Office preview adapter is unavailable.');
    return context.openLibreOfficePreview(file);
  }
}
