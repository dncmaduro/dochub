import { BaseFileEngine } from './base.engine.js';
import type {
  FileDescriptor,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export class PresentationEngine extends BaseFileEngine {
  readonly id = 'PRESENTATION' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);
  protected readonly extensions = new Set(['.ppt', '.pptx']);

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
