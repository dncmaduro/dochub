import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  extensionFromFilename,
  isGenericMimeType,
  normalizeExtension,
  normalizeMimeType,
  type FileDescriptor,
  type FileEngine,
  type FileEngineCapabilities,
  type FileEngineId,
  type FileEngineOpenContext,
  type FilePreviewResult,
} from './file-engine.types.js';
import { AudioEngine } from './engines/audio.engine.js';
import { DocumentEngine } from './engines/document.engine.js';
import { FallbackEngine } from './engines/fallback.engine.js';
import { ImageEngine } from './engines/image.engine.js';
import { LegacyGoogleNativeEngine } from './engines/legacy-google-native.engine.js';
import { PdfEngine } from './engines/pdf.engine.js';
import { PresentationEngine } from './engines/presentation.engine.js';
import { SpreadsheetEngine } from './engines/spreadsheet.engine.js';
import { TextEngine } from './engines/text.engine.js';
import { VideoEngine } from './engines/video.engine.js';

export const FILE_ENGINES = Symbol('FILE_ENGINES');

export interface ResolvedFileEngine {
  engine: FileEngine;
  capabilities: FileEngineCapabilities;
}

const defaultEngines = (): FileEngine[] => [
  new LegacyGoogleNativeEngine(),
  new DocumentEngine(),
  new SpreadsheetEngine(),
  new PresentationEngine(),
  new PdfEngine(),
  new ImageEngine(),
  new TextEngine(),
  new VideoEngine(),
  new AudioEngine(),
  new FallbackEngine(),
];

@Injectable()
export class FileEngineRegistry {
  private readonly engines: readonly FileEngine[];

  constructor(@Optional() @Inject(FILE_ENGINES) engines?: readonly FileEngine[]) {
    const registered = [...(engines?.length ? engines : defaultEngines())];
    if (!registered.some((engine) => engine.id === 'FALLBACK')) registered.push(new FallbackEngine());
    this.engines = registered
      .map((engine, index) => ({ engine, index }))
      .sort((left, right) => (right.engine.priority ?? 0) - (left.engine.priority ?? 0) || left.index - right.index)
      .map(({ engine }) => engine);
  }

  resolve(file: FileDescriptor): ResolvedFileEngine {
    const mimeType = normalizeMimeType(file.mimeType);
    const extension = normalizeExtension(file.extension ?? extensionFromFilename(file.name));
    const candidates = isGenericMimeType(mimeType)
      ? this.engines.filter((engine) => this.matchesExtension(engine, file, extension))
      : this.engines.filter((engine) => this.matchesMime(engine, file, mimeType));
    const engine = candidates[0] ?? this.engines.find((candidate) => candidate.id === 'FALLBACK')!;
    return { engine, capabilities: engine.capabilities(file) };
  }

  private matchesMime(engine: FileEngine, file: FileDescriptor, mimeType: string): boolean {
    return engine.matchesMime
      ? engine.matchesMime(mimeType)
      : engine.matches({ ...file, mimeType, extension: null });
  }

  private matchesExtension(engine: FileEngine, file: FileDescriptor, extension: string): boolean {
    return engine.matchesExtension
      ? engine.matchesExtension(extension)
      : engine.matches({ ...file, mimeType: 'application/octet-stream', extension });
  }

  get(id: FileEngineId): FileEngine {
    return this.engines.find((engine) => engine.id === id) ?? this.engines.find((engine) => engine.id === 'FALLBACK')!;
  }

  async openPreview(file: FileDescriptor): Promise<FilePreviewResult & { engine: FileEngine; capabilities: FileEngineCapabilities }> {
    const resolved = this.resolve(file);
    return { ...(await resolved.engine.openPreview(file)), engine: resolved.engine, capabilities: resolved.capabilities };
  }

  list(): readonly FileEngine[] {
    return this.engines;
  }

  async openContent(
    file: FileDescriptor,
    context: FileEngineOpenContext,
  ) {
    const resolved = this.resolve(file);
    if (!resolved.engine.openContent) throw new Error(`Engine ${resolved.engine.id} cannot open content.`);
    return resolved.engine.openContent(file, context);
  }
}
