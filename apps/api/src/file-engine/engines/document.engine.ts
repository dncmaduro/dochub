import { BaseFileEngine } from './base.engine.js';
import { Readable } from 'node:stream';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import { DocxPackageReader } from '../document/docx-package-reader.js';
import { DocxParser } from '../document/docx-parser.js';
import type { DocumentModel } from '../document/document-model.js';
import type {
  FileDescriptor,
  FileEngineModelContext,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME_TYPES = new Set(['application/msword', 'application/vnd.ms-word']);

export function isDocxFile(file: FileDescriptor): boolean {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType === DOCX_MIME_TYPE) return true;
  if (DOC_MIME_TYPES.has(mimeType)) return false;
  return file.extension?.trim().toLowerCase() === '.docx' || file.name.toLowerCase().endsWith('.docx');
}

export function isExpectedDocxFailure(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'expected' in error && (error as { expected?: unknown }).expected === true);
}

export class DocumentEngine extends BaseFileEngine {
  readonly id = 'DOCUMENT' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([
    'application/msword',
    'application/vnd.ms-word',
    DOCX_MIME_TYPE,
  ]);
  protected readonly extensions = new Set(['.doc', '.docx']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    return isDocxFile(file)
      ? { kind: 'document', mimeType: DOCX_MIME_TYPE }
      : { kind: 'pdf', mimeType: 'application/pdf' };
  }

  async openContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent> {
    if (isDocxFile(file) && !context.forceLibreOfficePreview) return this.openStoredContent(file, context);
    if (!context.openLibreOfficePreview) throw new Error('Office preview adapter is unavailable.');
    return context.openLibreOfficePreview(file);
  }

  async openModel(file: FileDescriptor, context: FileEngineModelContext): Promise<DocumentModel> {
    if (!isDocxFile(file)) throw new FileFormatUnsupportedError('Native document preview supports DOCX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native DOCX preview.');
    const packageReader = await DocxPackageReader.fromStorage(context.storage, file.storageRef);
    return DocxParser.parse(packageReader, context.assetUrl).model;
  }

  async openAsset(file: FileDescriptor, assetId: string, context: FileEngineModelContext): Promise<FilePreviewContent> {
    if (!isDocxFile(file)) throw new FileFormatUnsupportedError('Native document preview supports DOCX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native DOCX preview.');
    const packageReader = await DocxPackageReader.fromStorage(context.storage, file.storageRef);
    const parsed = DocxParser.parse(packageReader);
    const asset = parsed.assets.get(assetId);
    if (!asset) throw new FileFormatUnsupportedError('The document image is unavailable.');
    return {
      stream: Readable.from([Buffer.from(asset.entry.bytes)]),
      mimeType: asset.mimeType,
      sizeBytes: BigInt(asset.entry.bytes.byteLength),
      range: null,
    };
  }
}
