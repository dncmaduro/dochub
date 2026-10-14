import { Logger } from '@nestjs/common';
import { BaseFileEngine } from './base.engine.js';
import { Readable } from 'node:stream';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import { DocxPackageReader } from '../document/docx-package-reader.js';
import { DocxParser } from '../document/docx-parser.js';
import { DocxPatcher, type DocxPatchDiagnostic } from '../document/docx-patcher.js';
import { DocumentEditValidationError, parseDocumentPatchRequest } from '../document/document-edit.types.js';
import type { DocumentBlock, DocumentModel } from '../document/document-model.js';
import { findDocumentBlock } from '../document/docx-source-map.js';
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

function safeModelBlockSummary(model: DocumentModel): string {
  const blocks: string[] = [];
  const visit = (items: DocumentBlock[]): void => {
    for (const block of items) {
      blocks.push(`${block.id}:${block.type}:${'editable' in block && block.editable === false ? 'readonly' : 'editable'}${'readonlyReason' in block && block.readonlyReason ? `:${block.readonlyReason}` : ''}`);
      if (block.type === 'table') for (const row of block.rows) for (const cell of row.cells) visit(cell.blocks);
    }
  };
  visit(model.blocks);
  const limit = 512;
  return blocks.length <= limit ? blocks.join(',') : `${blocks.slice(0, limit).join(',')},truncated=${blocks.length - limit}`;
}

function safeChangedBlockSummary(request: ReturnType<typeof parseDocumentPatchRequest>, model?: DocumentModel): string {
  return request.blocks.map((patch) => {
    const current = model ? findDocumentBlock(model, patch.blockId) : null;
    const currentState = !current ? 'missing' : `${current.type}:${'editable' in current && current.editable === false ? 'readonly' : 'editable'}${'readonlyReason' in current && current.readonlyReason ? `:${current.readonlyReason}` : ''}`;
    return `${patch.blockId}:${patch.type}->${currentState}`;
  }).join(',');
}

function safeFailureKind(error: unknown): string {
  if (error instanceof DocumentEditValidationError) return error.code;
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return error instanceof Error ? error.constructor.name : typeof error;
}

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
  private readonly logger = new Logger(DocumentEngine.name);
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
    const diagnostics = (detail: DocxPatchDiagnostic): void => {
      const modelSummary = detail.currentModel ? safeModelBlockSummary(detail.currentModel) : 'unavailable';
      const changedSummary = safeChangedBlockSummary(request, detail.currentModel);
      const message = `DOCX save diagnostics stage=${detail.stage} expectedRevision=${request.expectedRevision} operationId=${request.operationId ?? 'missing'} changedBlockCount=${request.blocks.length} changedBlocks=${changedSummary} currentBlockCount=${detail.currentModel?.blocks.length ?? 'unavailable'} currentBlocks=${modelSummary}`;
      if (detail.error) this.logger.warn(`${message} failure=${safeFailureKind(detail.error)}${detail.blockId ? ` blockId=${detail.blockId}` : ''}`);
      else this.logger.debug(message);
    };
    this.logger.debug(`DOCX save request expectedRevision=${request.expectedRevision} operationId=${request.operationId ?? 'missing'} changedBlockCount=${request.blocks.length} changedBlocks=${safeChangedBlockSummary(request)}`);
    const patched = DocxPatcher.apply(sourceBytes, request, diagnostics);
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
