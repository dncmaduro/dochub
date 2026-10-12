import { BaseFileEngine } from './base.engine.js';
import type {
  FileDescriptor,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export class LegacyGoogleNativeEngine extends BaseFileEngine {
  readonly id = 'LEGACY_GOOGLE_NATIVE' as const;
  readonly priority = 100;
  protected readonly mimeTypes = new Set([
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
  ]);
  protected readonly extensions = new Set<string>();

  async openPreview(_file: FileDescriptor): Promise<FilePreviewResult> {
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }

  async openContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent> {
    if (!context.openLegacyGoogleNativePreview) throw new Error('Google-native preview adapter is unavailable.');
    return context.openLegacyGoogleNativePreview(file);
  }
}
