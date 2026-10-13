import { BaseFileEngine } from './base.engine.js';
import { Readable } from 'node:stream';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import { DocxPackageReader } from '../document/docx-package-reader.js';
import { DocxParser } from '../document/docx-parser.js';
import { DocxPatcher } from '../document/docx-patcher.js';
import { parseDocumentPatchRequest } from '../document/document-edit.types.js';
import type { DocumentModel } from '../document/document-model.js';
import { StorageConflictError } from '../../storage/storage.errors.js';
import type {
  FileDescriptor,
  FileEngineModelContext,
  FileEngineOpenContext,
  FilePreviewContent,
  FilePreviewResult,
  PreparedFileSave,
} from '../file-engine.types.js';
import { readSourceBytes } from '../file-engine.types.js';

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

  capabilities(file: FileDescriptor) {
    return { ...this.defaultCapabilities, edit: isDocxFile(file) && Boolean(file.storageRef) };
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
    const model = DocxParser.parse(packageReader, context.assetUrl).model;
    model.storageRevision = context.storageRevision;
    model.editable = Boolean(model.editable);
    return model;
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

  async prepareSave(file: FileDescriptor, model: unknown, context: import('../file-engine.types.js').FileEngineSaveContext): Promise<PreparedFileSave> {
    if (!isDocxFile(file)) throw new FileFormatUnsupportedError('Native document editing supports DOCX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native DOCX editing.');
    const request = parseDocumentPatchRequest(model);
    DocxPatcher.assertWithinLimits(request);
    const source = context.source ?? { stat: () => context.storage.stat(file.storageRef!), openRead: () => context.storage.openRead(file.storageRef!) };
    const current = await source.stat();
    if (current.revision !== request.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const sourceBytes = await readSourceBytes(source);
    const patched = DocxPatcher.apply(sourceBytes, request);
    return { stream: Readable.from([patched.bytes]), mimeType: DOCX_MIME_TYPE, sizeBytes: BigInt(patched.bytes.byteLength) };
  }

  async save(file: FileDescriptor, model: unknown, context: import('../file-engine.types.js').FileEngineSaveContext): Promise<{ storageRevision: string; model: DocumentModel }> {
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native DOCX editing.');
    const prepared = await this.prepareSave(file, model, context);
    const stored = await context.storage.replace(
      file.storageRef,
      { stream: prepared.stream, mimeType: prepared.mimeType },
      { expectedRevision: context.expectedRevision },
    );
    if (!stored.metadata.revision) throw new Error('Storage provider did not return a new revision');
    const savedPackage = await DocxPackageReader.fromStorage(context.storage, file.storageRef);
    const savedModel = DocxParser.parse(savedPackage, context.assetUrl).model;
    savedModel.storageRevision = stored.metadata.revision;
    savedModel.editable = Boolean(savedModel.editable);
    return { storageRevision: stored.metadata.revision, model: savedModel };
  }
}
