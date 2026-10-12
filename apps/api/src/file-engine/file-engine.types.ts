import type { Readable } from 'node:stream';
import type {
  StorageByteRange,
  StorageObjectRef,
  StorageProvider,
  StorageReadResult,
} from '../storage/storage-provider.js';

/** Built-in IDs are stable strings; applications may register additional IDs. */
export type FileEngineId = string;

export type FilePreviewKind =
  | 'pdf'
  | 'image'
  | 'text'
  | 'video'
  | 'audio'
  | 'unavailable';

export interface FileDescriptor {
  fileId: string;
  nodeId: string;
  name: string;
  mimeType: string | null;
  extension: string | null;
  size: number | null;
  /** Null is used only by the legacy local-file compatibility path. */
  storageRef: StorageObjectRef | null;
}

export interface FileEngineCapabilities {
  preview: boolean;
  edit: boolean;
  download: boolean;
  textExtraction: boolean;
  thumbnail: boolean;
}

export interface FilePreviewResult {
  kind: FilePreviewKind;
  mimeType: string | null;
  reason?: 'unsupported' | 'source-unavailable' | 'failed';
}

export interface FilePreviewContent {
  stream: Readable;
  mimeType: string;
  sizeBytes: bigint | null;
  range: { start: number; end: number; total: number } | null;
  cleanup?: () => Promise<void>;
}

export interface FileEngineOpenContext {
  storage: StorageProvider;
  range?: StorageByteRange;
  openLibreOfficePreview?: (
    file: FileDescriptor,
  ) => Promise<FilePreviewContent>;
  openLegacyGoogleNativePreview?: (
    file: FileDescriptor,
  ) => Promise<FilePreviewContent>;
}

export interface FileEngine {
  readonly id: FileEngineId;
  readonly priority?: number;
  matches(file: FileDescriptor): boolean;
  matchesMime?(mimeType: string): boolean;
  matchesExtension?(extension: string): boolean;
  capabilities(file: FileDescriptor): FileEngineCapabilities;
  openPreview(file: FileDescriptor): Promise<FilePreviewResult>;
  openContent?(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ): Promise<FilePreviewContent>;
  /** Reserved for a future DocumentModel/WorkbookModel/PresentationModel. */
  openModel?(file: FileDescriptor, context: FileEngineModelContext): Promise<unknown>;
  /** Future implementations must serialize through StorageProvider.replace(). */
  save?(file: FileDescriptor, model: unknown, context: FileEngineSaveContext): Promise<unknown>;
  extractText?(file: FileDescriptor, context: FileEngineModelContext): Promise<string>;
  generateThumbnail?(file: FileDescriptor, context: FileEngineModelContext): Promise<FilePreviewContent>;
}

export interface FileEngineModelContext {
  storage: StorageProvider;
}

export interface FileEngineSaveContext extends FileEngineModelContext {
  expectedRevision?: string;
}

export function normalizeMimeType(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export function normalizeExtension(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

export function extensionFromFilename(name: string): string | null {
  const match = /\.[a-z0-9]+$/i.exec(name.trim());
  return match ? match[0].toLowerCase() : null;
}

export function isGenericMimeType(mimeType: string | null | undefined): boolean {
  const normalized = normalizeMimeType(mimeType);
  return normalized === '' || normalized === 'application/octet-stream' || normalized === 'binary/octet-stream';
}

export function storageContent(content: StorageReadResult): FilePreviewContent {
  return {
    stream: content.stream,
    mimeType: content.metadata.mimeType,
    sizeBytes: content.metadata.sizeBytes,
    range: content.range,
    cleanup: content.cleanup,
  };
}
