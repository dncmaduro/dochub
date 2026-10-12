import { Readable } from 'node:stream';
import { StorageConflictError } from '../../storage/storage.errors.js';
import { FileFormatUnsupportedError } from '../file-engine.errors.js';
import {
  extensionFromFilename,
  isGenericMimeType,
  normalizeMimeType,
  type FileDescriptor,
  type FileEngineCapabilities,
  type FileEngineModelContext,
  type FileEngineSaveContext,
  type FilePreviewResult,
} from '../file-engine.types.js';
import { BaseFileEngine } from './base.engine.js';
import { TEXT_LIMITS } from '../text/text-limits.js';
import { parseTextPatchRequest, TextEditValidationError } from '../text/text-edit.types.js';
import {
  buildTextModel,
  encodeUtf8,
  readTextSource,
  structuredPreview,
  TextSourceError,
  TextValidationError,
  validateXml,
} from '../text/text-source.js';
import type { TextFileFormat, TextFileModel } from '../text/text-model.js';

const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/xml',
  'text/xml',
]);

export function textFormat(file: FileDescriptor): TextFileFormat {
  const mime = normalizeMimeType(file.mimeType);
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime === 'application/json') return 'json';
  if (mime === 'application/xml' || mime === 'text/xml') return 'xml';
  if (mime === 'text/plain') return 'text';
  const extension = normalizeTextExtension(file.extension ?? extensionFromFilename(file.name));
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.json') return 'json';
  if (extension === '.xml') return 'xml';
  return 'text';
}

function normalizeTextExtension(extension: string | null | undefined): string {
  const normalized = extension?.trim().toLowerCase() ?? '';
  return normalized.startsWith('.') ? normalized : normalized ? `.${normalized}` : '';
}

export function isTextFile(file: FileDescriptor): boolean {
  const mime = normalizeMimeType(file.mimeType);
  if (!isGenericMimeType(mime)) return TEXT_MIME_TYPES.has(mime);
  const extension = normalizeTextExtension(file.extension ?? extensionFromFilename(file.name));
  return ['.txt', '.md', '.markdown', '.json', '.xml'].includes(extension);
}

export function isExpectedTextFailure(error: unknown): boolean {
  return error instanceof TextSourceError;
}

export class TextEngine extends BaseFileEngine {
  readonly id = 'TEXT' as const;
  readonly priority = 40;
  protected readonly mimeTypes = TEXT_MIME_TYPES;
  protected readonly extensions = new Set(['.txt', '.md', '.markdown', '.json', '.xml']);

  capabilities(file: FileDescriptor): FileEngineCapabilities {
    const size = file.size;
    return {
      ...this.defaultCapabilities,
      textExtraction: true,
      edit: Boolean(file.storageRef) && (size === null || size <= TEXT_LIMITS.maxEditableBytes),
    };
  }

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult> {
    const format = textFormat(file);
    const mimeType = isGenericMimeType(file.mimeType)
      ? format === 'markdown' ? 'text/markdown' : format === 'json' ? 'application/json' : format === 'xml' ? 'application/xml' : 'text/plain'
      : file.mimeType;
    return { kind: 'text', mimeType, format };
  }

  openContent = this.openStoredContent.bind(this);

  async openModel(file: FileDescriptor, context: FileEngineModelContext): Promise<TextFileModel> {
    if (!isTextFile(file)) throw new FileFormatUnsupportedError('Native text preview supports TXT, Markdown, JSON, and XML only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native text preview.');
    const source = await readTextSource(context.storage, file.storageRef);
    const format = textFormat(file);
    const editable = source.byteLength <= TEXT_LIMITS.maxEditableBytes;
    return buildTextModel(format, source, editable, context.storageRevision);
  }

  async extractText(file: FileDescriptor, context: FileEngineModelContext): Promise<string> {
    if (!isTextFile(file) || !file.storageRef) throw new FileFormatUnsupportedError('Text extraction is unavailable.');
    return (await readTextSource(context.storage, file.storageRef)).content;
  }

  async save(file: FileDescriptor, model: unknown, context: FileEngineSaveContext): Promise<{ storageRevision: string; model: TextFileModel }> {
    if (!isTextFile(file)) throw new FileFormatUnsupportedError('Native text editing supports TXT, Markdown, JSON, and XML only.');
    if (!file.storageRef) throw new FileFormatUnsupportedError('A storage reference is required for native text editing.');
    const parsed = parseTextPatchRequest(model);
    if (parsed.expectedRevision !== context.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const current = await context.storage.stat(file.storageRef);
    if (current.revision !== parsed.expectedRevision) throw new StorageConflictError('Storage object revision has changed');
    const source = await readTextSource(context.storage, file.storageRef);
    const format = textFormat(file);
    validateBeforeSave(format, parsed.content);
    const output = encodeUtf8(source, parsed.content);
    const stored = await context.storage.replace(
      file.storageRef,
      { stream: Readable.from([output]), mimeType: current.mimeType || file.mimeType || 'text/plain' },
      { expectedRevision: parsed.expectedRevision },
    );
    if (!stored.metadata.revision) throw new Error('Storage provider did not return a new revision');
    const savedModel = await this.openModel(file, { ...context, storageRevision: stored.metadata.revision });
    return { storageRevision: stored.metadata.revision, model: savedModel };
  }
}

function validateBeforeSave(format: TextFileFormat, content: string): void {
  if (format === 'json') {
    const preview = structuredPreview(format, content);
    if (preview.parseError) throw new TextEditValidationError(preview.parseError);
  }
  if (format === 'xml') {
    try {
      validateXml(content);
    } catch (error) {
      if (error instanceof TextValidationError) throw new TextEditValidationError(error.message);
      throw new TextEditValidationError('XML is not well-formed.');
    }
  }
  if (content.length > TEXT_LIMITS.maxDecodedCharacters) throw new TextEditValidationError('Edited text is too large.');
}
