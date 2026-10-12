import { Readable } from 'node:stream';
import { BaseFileEngine } from './base.engine.js';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import { PptxPackageReader } from '../presentation/pptx-package-reader.js';
import { PptxParser } from '../presentation/pptx-parser.js';
import { PptxPatcher } from '../presentation/pptx-patcher.js';
import { parsePresentationPatchRequest } from '../presentation/presentation-edit.types.js';
import type { PresentationModel } from '../presentation/presentation-model.js';
import { StorageConflictError } from '../../storage/storage.errors.js';
import type {
  FileDescriptor,
  FileEngineModelContext,
  FileEngineOpenContext,
  FileEngineSaveContext,
  FilePreviewContent,
  FilePreviewResult,
} from '../file-engine.types.js';

export const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
export const PPT_MIME_TYPE = 'application/vnd.ms-powerpoint';

export function isPptxFile(file: FileDescriptor): boolean {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType === PPTX_MIME_TYPE) return true;
  if (mimeType === PPT_MIME_TYPE) return false;
  return file.extension?.trim().toLowerCase() === '.pptx' || file.name.toLowerCase().endsWith('.pptx');
}

export function isPptFile(file: FileDescriptor): boolean {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType === PPT_MIME_TYPE) return true;
  if (mimeType === PPTX_MIME_TYPE) return false;
  return file.extension?.trim().toLowerCase() === '.ppt' || file.name.toLowerCase().endsWith('.ppt');
}

export class PresentationEngine extends BaseFileEngine {
  readonly id = 'PRESENTATION' as const;
  readonly priority = 70;
  protected readonly mimeTypes = new Set([PPT_MIME_TYPE, PPTX_MIME_TYPE]);
  protected readonly extensions = new Set(['.ppt', '.pptx']);

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    return isPptxFile(file) ? { kind: 'presentation', mimeType: PPTX_MIME_TYPE } : { kind: 'pdf', mimeType: 'application/pdf' };
  }

  capabilities(file: FileDescriptor) {
    return { ...this.defaultCapabilities, edit: isPptxFile(file) && Boolean(file.storageRef) };
  }

  async openContent(file: FileDescriptor, context: FileEngineOpenContext): Promise<FilePreviewContent> {
    if (isPptxFile(file) && !context.forceLibreOfficePreview) return this.openStoredContent(file, context);
    if (!context.openLibreOfficePreview) throw new Error('Office preview adapter is unavailable.');
    return context.openLibreOfficePreview(file);
  }

  async openModel(file: FileDescriptor, context: FileEngineModelContext): Promise<PresentationModel> {
    if (!isPptxFile(file)) throw new FileFormatUnsupportedError('Native presentation preview supports PPTX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native PPTX preview.');
    const reader = await PptxPackageReader.fromStorage(context.storage, file.storageRef);
    return new PptxParser(reader).parseManifest(context.storageRevision, Boolean(file.storageRef)).model;
  }

  async openSlide(file: FileDescriptor, slideId: string, context: FileEngineModelContext) {
    if (!isPptxFile(file)) throw new FileFormatUnsupportedError('Native presentation preview supports PPTX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native PPTX preview.');
    const reader = await PptxPackageReader.fromStorage(context.storage, file.storageRef);
    return new PptxParser(reader).slide(slideId, context.assetUrl);
  }

  async openAsset(file: FileDescriptor, assetId: string, context: FileEngineModelContext): Promise<FilePreviewContent> {
    if (!isPptxFile(file)) throw new FileFormatUnsupportedError('Native presentation preview supports PPTX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native PPTX preview.');
    const reader = await PptxPackageReader.fromStorage(context.storage, file.storageRef);
    const asset = new PptxParser(reader).asset(assetId);
    if (!asset) throw new FileFormatUnsupportedError('The presentation image is unavailable.');
    const entry = reader.entry(asset.path);
    if (!entry) throw new FileFormatUnsupportedError('The presentation image is unavailable.');
    return { stream: Readable.from([Buffer.from(entry.bytes)]), mimeType: asset.mimeType, sizeBytes: BigInt(entry.bytes.byteLength), range: null };
  }

  async save(file: FileDescriptor, model: unknown, context: FileEngineSaveContext): Promise<{ storageRevision: string; model: PresentationModel }> {
    if (!isPptxFile(file)) throw new FileFormatUnsupportedError('Native presentation editing supports PPTX only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native PPTX editing.');
    const request = parsePresentationPatchRequest(model);
    PptxPatcher.assertWithinLimits(request);
    const current = await context.storage.stat(file.storageRef);
    if (current.revision !== request.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const source = await PptxPackageReader.readStorageBytes(context.storage, file.storageRef);
    const patched = PptxPatcher.apply(source, request);
    const stored = await context.storage.replace(file.storageRef, { stream: Readable.from([patched.bytes]), mimeType: PPTX_MIME_TYPE }, { expectedRevision: request.expectedRevision });
    if (!stored.metadata.revision) throw new Error('Storage provider did not return a new revision');
    const savedReader = await PptxPackageReader.fromStorage(context.storage, file.storageRef);
    const savedModel = new PptxParser(savedReader).parseManifest(stored.metadata.revision, true).model;
    return { storageRevision: stored.metadata.revision, model: savedModel };
  }
}
