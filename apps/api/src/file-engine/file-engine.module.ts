import { Module } from '@nestjs/common';
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
import { FILE_ENGINES, FileEngineRegistry } from './file-engine.registry.js';
import type { FileEngine } from './file-engine.types.js';

@Module({
  providers: [
    AudioEngine,
    DocumentEngine,
    FallbackEngine,
    ImageEngine,
    LegacyGoogleNativeEngine,
    PdfEngine,
    PresentationEngine,
    SpreadsheetEngine,
    TextEngine,
    VideoEngine,
    {
      provide: FILE_ENGINES,
      inject: [
        LegacyGoogleNativeEngine,
        DocumentEngine,
        SpreadsheetEngine,
        PresentationEngine,
        PdfEngine,
        ImageEngine,
        TextEngine,
        VideoEngine,
        AudioEngine,
        FallbackEngine,
      ],
      useFactory: (...engines: FileEngine[]) => engines,
    },
    FileEngineRegistry,
  ],
  exports: [FileEngineRegistry],
})
export class FileEngineModule {}
