import { BaseFileEngine } from './base.engine.js';
import { extensionFromFilename } from '../file-engine.types.js';
import type {
  FileDescriptor,
  FileEngineCapabilities,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export class SpreadsheetEngine extends BaseFileEngine {
  readonly id = 'SPREADSHEET' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/csv',
  ]);
  protected readonly extensions = new Set(['.xls', '.xlsx', '.csv']);

  capabilities(_file: FileDescriptor): FileEngineCapabilities {
    return { ...this.defaultCapabilities, preview: true };
  }

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    const extension = (file.extension ?? extensionFromFilename(file.name) ?? '').toLowerCase();
    const mimeType = (file.mimeType ?? '').toLowerCase();
    if (extension === '.csv' || mimeType === 'text/csv' || mimeType === 'application/csv') {
      return { kind: 'text', mimeType: 'text/csv' };
    }
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }

  async openContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent> {
    const preview = await this.openPreview(file);
    if (preview.kind === 'text') return this.openStoredContent(file, context);
    if (!context.openLibreOfficePreview) throw new Error('Office preview adapter is unavailable.');
    return context.openLibreOfficePreview(file);
  }
}
